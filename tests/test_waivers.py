"""揭晓后弃权—递补的端到端回归。

演示种子（0123...×4）在 5 人名单 [A001..A005] 上的完整排列为：

    A003, A005, A001, A002, A004

原始中奖取前 3 个；弃权续选从第 3 轮（draw_index=3）起取 A002、A004，
之后候补耗尽、席位留空。本文件据此验证：

- 未揭晓/非当前编号不可弃权，原始中奖者与递补者均可弃权；
- 续选严格按既有 sha256-argmax-v1 排列，逐次补位、无人占两席；
- 重复提交同一弃权返回已有结果（幂等）；
- 候补耗尽留空席，空席不可再操作；
- 核验包附带 waivers/seats，verify.py 独立重演通过，并能抓出伪造/跳过递补；
- 旧版包（无 waivers 字段）继续核验通过。
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

from app import rules

from .helpers import create_round, demo_commitment, make_app, replace

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERIFIER = os.path.join(ROOT_DIR, "verify", "verify.py")

PERM_5 = ["A003", "A005", "A001", "A002", "A004"]


class WaiverFlowTest(unittest.TestCase):
    def setUp(self):
        self.app, self.db_path = make_app()
        self.client = self.app.test_client()
        self.seed, self.commitment = demo_commitment()

    def tearDown(self):
        for suffix in ("", "-wal", "-shm"):
            path = self.db_path + suffix
            if os.path.exists(path):
                os.remove(path)

    # ------------------------------------------------ 辅助

    def _ready_round(self, entries=("A001", "A002", "A003", "A004", "A005"),
                     prize=3):
        rid = create_round(
            self.client, title="弃权测试", prize_count=prize,
            commitment=self.commitment,
        )
        replace(self.client, rid, list(entries))
        self.assertEqual(
            self.client.post(f"/api/rounds/{rid}/seal").status_code, 200
        )
        r = self.client.post(
            f"/api/rounds/{rid}/reveal", json={"seed": self.seed}
        )
        self.assertEqual(r.status_code, 200)
        return rid

    def _get(self, rid):
        r = self.client.get(f"/api/rounds/{rid}")
        self.assertEqual(r.status_code, 200)
        return r.get_json()["round"]

    def _waive(self, rid, seat, entry_id, reason=None):
        body = {"seat": seat, "entryId": entry_id}
        if reason is not None:
            body["reason"] = reason
        return self.client.post(
            f"/api/rounds/{rid}/waivers", json=body
        )

    def _run_verifier(self, pkg):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "package.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(pkg, f, ensure_ascii=False)
            return subprocess.run(
                [sys.executable, VERIFIER, path],
                capture_output=True, text=True,
            )

    def _export(self, rid):
        r = self.client.get(f"/api/rounds/{rid}/package.json")
        self.assertEqual(r.status_code, 200)
        return json.loads(r.get_data(as_text=True))

    # ------------------------------------------------ 基础不变量

    def test_original_order_never_changes(self):
        rid = self._ready_round()
        self.assertEqual(self._get(rid)["winners"], PERM_5[:3])

        r = self._waive(rid, 1, "A003", reason="出差")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertEqual(data["round"]["winners"], PERM_5[:3])  # 原始顺序不变
        self.assertEqual(data["round"]["seats"], ["A002", "A005", "A001"])

        w = data["round"]["waivers"][0]
        self.assertEqual(w["seq"], 1)
        self.assertEqual(w["seat"], 1)
        self.assertEqual(w["waivedId"], "A003")
        self.assertEqual(w["replacementId"], "A002")
        self.assertEqual(w["drawIndex"], 3)
        self.assertEqual(w["reason"], "出差")
        self.assertTrue(w["waivedAt"])

        # 揭晓时间依旧存在；再次查询结果稳定
        again = self._get(rid)
        self.assertEqual(again["revealedAt"],
                         self.client.get(f"/api/rounds/{rid}")
                         .get_json()["round"]["revealedAt"])
        self.assertEqual(again["winners"], PERM_5[:3])
        self.assertEqual(again["seats"], ["A002", "A005", "A001"])

    def test_replacement_matches_permutation(self):
        """续选编号必须就是既有排列的后续项。"""
        rid = self._ready_round()
        # 第 2 席 A005 弃权 → 排列第 3 项 A002
        r = self._waive(rid, 2, "A005")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["round"]["seats"],
                         ["A003", "A002", "A001"])
        # 递补者 A002 再弃权 → 排列第 4 项 A004
        r = self._waive(rid, 2, "A002")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["round"]["seats"],
                         ["A003", "A004", "A001"])
        # 第 1 席 A003 弃权：A002/A004 都已出现，下一未出现者……排列已用尽到 A004
        # 排列 5 项中只剩无未出现编号？已出现 A003,A005,A001,A002,A004 全部
        r = self._waive(rid, 1, "A003")
        body = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(body["round"]["seats"][0])  # 空席
        self.assertEqual(body["round"]["seats"],
                         [None, "A004", "A001"])
        # 空席的弃权记录 replacement/drawIndex 为空
        last = body["round"]["waivers"][-1]
        self.assertIsNone(last["replacementId"])
        self.assertIsNone(last["drawIndex"])

    def test_exhaustion_then_vacant_seat_not_operable(self):
        rid = self._ready_round()
        # 用掉全部两个候补：A002、A004
        self.assertEqual(self._waive(rid, 1, "A003").status_code, 200)
        self.assertEqual(self._waive(rid, 1, "A002").status_code, 200)
        data = self._get(rid)
        self.assertEqual(data["seats"], ["A004", "A005", "A001"])
        # 再让第 2 席弃权：排列用尽 → 空席
        r = self._waive(rid, 2, "A005")
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.get_json()["round"]["seats"][1])
        # 对同一次弃权（A005）重复提交：幂等返回已有记录（空席记录）
        r = self._waive(rid, 2, "A005")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["alreadyRecorded"])
        self.assertIsNone(r.get_json()["round"]["seats"][1])
        # 但不能把一个无关编号登记到这个空席
        r = self._waive(rid, 2, "A001")
        self.assertEqual(r.status_code, 409)
        self.assertIn("空席", r.get_json()["error"])

    # ------------------------------------------------ 拒绝条件

    def test_unrevealed_round_cannot_waive(self):
        rid = create_round(self.client, commitment=self.commitment)
        replace(self.client, rid, ["A001", "A002", "A003"])
        self.assertEqual(
            self.client.post(f"/api/rounds/{rid}/seal").status_code, 200
        )
        # sealed（未揭晓）
        r = self._waive(rid, 1, "A001")
        self.assertEqual(r.status_code, 409)
        self.assertIn("尚未揭晓", r.get_json()["error"])

    def test_non_current_id_rejected(self):
        rid = self._ready_round()
        # 已弃权的原中奖者重复提交同一次弃权 → 幂等 200（不是新的弃权）
        self.assertEqual(self._waive(rid, 1, "A003").status_code, 200)
        r = self._waive(rid, 1, "A003")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["alreadyRecorded"])
        # 别人席位的当前编号不能在本席弃权（它从未在第 1 席在任）
        r = self._waive(rid, 1, "A005")
        self.assertEqual(r.status_code, 409)
        self.assertIn("不是第 1 席的当前有效中奖编号", r.get_json()["error"])
        # 递补者 A002 就位后，无关的历史编号 A003 已在第 1 席弃权过（幂等）；
        # 而把从未在第 3 席在任的 A003 拿去第 3 席弃权 → 409
        r = self._waive(rid, 3, "A003")
        self.assertEqual(r.status_code, 409)
        # 不在名单的编号
        r = self._waive(rid, 2, "NOBODY")
        self.assertEqual(r.status_code, 409)
        # 席位越界 / 类型错误
        self.assertEqual(self._waive(rid, 0, "A005").status_code, 400)
        self.assertEqual(self._waive(rid, 4, "A005").status_code, 400)
        self.assertEqual(
            self.client.post(
                f"/api/rounds/{rid}/waivers",
                json={"seat": "1", "entryId": "A005"},
            ).status_code, 400
        )
        # 数据没有被失败请求破坏：仍只有 A003 一次弃权
        data = self._get(rid)
        self.assertEqual(len(data["waivers"]), 1)
        self.assertEqual(data["seats"], ["A002", "A005", "A001"])

    def test_round_not_found(self):
        r = self._waive("deadbeefdeadbeef", 1, "X")
        self.assertEqual(r.status_code, 404)

    # ------------------------------------------------ 幂等

    def test_duplicate_waiver_is_idempotent(self):
        rid = self._ready_round()
        r1 = self._waive(rid, 1, "A003")
        r2 = self._waive(rid, 1, "A003")  # 完全重复
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        b1, b2 = r1.get_json(), r2.get_json()
        self.assertTrue(b2["alreadyRecorded"])
        self.assertEqual(
            b1["round"]["waivers"], b2["round"]["waivers"]
        )
        self.assertEqual(len(b2["round"]["waivers"]), 1)
        self.assertEqual(b2["round"]["seats"], ["A002", "A005", "A001"])

        # 递补者弃权后，对“递补者”重复提交也是幂等，且不会多抽
        r3 = self._waive(rid, 1, "A002")
        r4 = self._waive(rid, 1, "A002")
        self.assertEqual(r3.status_code, 200)
        self.assertTrue(r4.get_json()["alreadyRecorded"])
        data = self._get(rid)
        self.assertEqual([w["waivedId"] for w in data["waivers"]],
                         ["A003", "A002"])
        self.assertEqual([w["seq"] for w in data["waivers"]], [1, 2])
        self.assertEqual(data["seats"], ["A004", "A005", "A001"])

    # ------------------------------------------------ 并发串行

    def test_concurrent_waivers_serialize_per_round(self):
        """同轮次并发弃权必须串行：每个编号至多占一席，弃权与递补成对出现。"""
        rid = self._ready_round()
        gate_ready = threading.Event()
        gate_go = threading.Event()
        seen = {"n": 0}
        lock = threading.Lock()
        results = []

        def waive(seat, entry_id):
            local = self.app.test_client()
            with lock:
                seen["n"] += 1
                if seen["n"] == 2:
                    gate_ready.set()
            gate_go.wait(5)
            r = local.post(
                f"/api/rounds/{rid}/waivers",
                json={"seat": seat, "entryId": entry_id},
            )
            results.append((seat, entry_id, r))

        t1 = threading.Thread(target=waive, args=(1, "A003"))
        t2 = threading.Thread(target=waive, args=(2, "A005"))
        t1.start(); t2.start()
        gate_ready.wait(5)
        gate_go.set()
        t1.join(10); t2.join(10)
        self.assertFalse(t1.is_alive() or t2.is_alive())

        for _s, _e, r in results:
            self.assertEqual(r.status_code, 200, r.get_data(as_text=True))

        data = self._get(rid)
        self.assertEqual(len(data["waivers"]), 2)
        self.assertEqual(sorted(w["seat"] for w in data["waivers"]), [1, 2])
        self.assertEqual(sorted(w["waivedId"] for w in data["waivers"]),
                         ["A003", "A005"])
        # 两个席位由 A002、A004 递补（顺序取决于谁先拿到锁），无人占两席
        occupied = [s for s in data["seats"] if s is not None]
        self.assertEqual(sorted(occupied), ["A001", "A002", "A004"])
        self.assertEqual(len(set(occupied)), len(occupied))
        # 每个弃权都有且仅有一个递补（无只记弃权不记递补）
        self.assertTrue(all(w["replacementId"] for w in data["waivers"]))
        self.assertEqual(sorted(w["replacementId"] for w in data["waivers"]),
                         ["A002", "A004"])
        # draw_index 必须接续排列：3 与 4 各一次
        self.assertEqual(sorted(w["drawIndex"] for w in data["waivers"]),
                         [3, 4])

    def test_concurrent_duplicate_same_waiver_single_record(self):
        """并发重复提交同一弃权：恰好一条记录，两个请求都返回同一结果。"""
        rid = self._ready_round()
        outcomes = []

        def fire():
            r = self.app.test_client().post(
                f"/api/rounds/{rid}/waivers",
                json={"seat": 1, "entryId": "A003"},
            )
            outcomes.append(r)

        threads = [threading.Thread(target=fire) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
            self.assertFalse(t.is_alive())

        self.assertEqual(len(outcomes), 4)
        for r in outcomes:
            self.assertEqual(r.status_code, 200)
        records = [r.get_json()["round"]["waivers"] for r in outcomes]
        for rec in records:
            self.assertEqual(len(rec), 1)
            self.assertEqual(rec[0]["replacementId"], "A002")
        # 恰好一个是“新记录”，其余幂等返回
        self.assertEqual(
            sum(1 for r in outcomes if r.get_json().get("alreadyRecorded")),
            3,
        )
        self.assertEqual(len(self._get(rid)["waivers"]), 1)

    # ------------------------------------------------ 核验包与独立核验

    def test_package_contains_waivers_and_verifies(self):
        rid = self._ready_round()
        self._waive(rid, 1, "A003", reason="本人放弃")
        self._waive(rid, 2, "A005")  # 第 2 席 → 此时续选：见排列
        pkg = self._export(rid)

        self.assertEqual(pkg["winners"], PERM_5[:3])
        self.assertEqual(len(pkg["waivers"]), 2)
        # 第一次递补 A002（draw 3）；A002 在第 1 席，第二次续选取 A004（draw 4）
        self.assertEqual(pkg["waivers"][0]["replacementId"], "A002")
        self.assertEqual(pkg["waivers"][0]["drawIndex"], 3)
        self.assertEqual(pkg["waivers"][1]["replacementId"], "A004")
        self.assertEqual(pkg["waivers"][1]["drawIndex"], 4)
        self.assertEqual(pkg["seats"], ["A002", "A004", "A001"])

        proc = self._run_verifier(pkg)
        self.assertEqual(
            proc.returncode, 0,
            f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
        )
        self.assertIn("弃权—递补链", proc.stdout)
        self.assertIn("当前席位", proc.stdout)

    def test_verifier_detects_forged_replacement(self):
        rid = self._ready_round()
        self._waive(rid, 1, "A003")
        pkg = self._export(rid)
        # 伪造递补编号
        pkg["waivers"][0]["replacementId"] = "A005"
        pkg["seats"][0] = "A005"
        proc = self._run_verifier(pkg)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("递补编号伪造", proc.stdout)
        self.assertIn("当前席位与弃权链独立重演结果不一致", proc.stdout)

    def test_verifier_detects_skipped_draw_index(self):
        rid = self._ready_round()
        self._waive(rid, 1, "A003")
        pkg = self._export(rid)
        # 跳过续选轮次（伪造 drawIndex），编号本身也会对不上
        pkg["waivers"][0]["drawIndex"] = 9
        proc = self._run_verifier(pkg)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("drawIndex 跳过或伪造", proc.stdout)

    def test_verifier_detects_non_current_waived(self):
        rid = self._ready_round()
        self._waive(rid, 1, "A003")  # 第 1 席当前变为 A002
        pkg = self._export(rid)
        # 伪造记录：声称第 1 席此后又由 A003（已弃权、非当前）弃权
        forged = {
            "seq": 2, "seat": 1, "waivedId": "A003",
            "replacementId": "A004", "drawIndex": 4,
            "reason": None, "waivedAt": "2026-01-01T00:00:00Z",
        }
        pkg["waivers"].append(forged)
        proc = self._run_verifier(pkg)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("非当前编号不可弃权", proc.stdout)

    def test_verifier_detects_replayed_seq_gap(self):
        rid = self._ready_round()
        self._waive(rid, 1, "A003")
        pkg = self._export(rid)
        pkg["waivers"][0]["seq"] = 5  # 序号不连续 = 有记录被抽掉
        proc = self._run_verifier(pkg)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("seq 应为 1", proc.stdout)

    def test_verifier_handles_malformed_records(self):
        rid = self._ready_round()
        self._waive(rid, 1, "A003")
        base = self._export(rid)
        # seat 越界
        pkg = json.loads(json.dumps(base))
        pkg["waivers"][0]["seat"] = 99
        proc = self._run_verifier(pkg)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("seat 名次非法", proc.stdout)
        # 记录不是对象 / 不是数组 —— 核验器不得抛异常崩溃
        pkg = json.loads(json.dumps(base))
        pkg["waivers"] = ["junk"]
        proc = self._run_verifier(pkg)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("不是对象", proc.stdout)
        pkg = json.loads(json.dumps(base))
        pkg["waivers"] = {"not": "a list"}
        proc = self._run_verifier(pkg)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("waivers 字段不是数组", proc.stdout)

    def test_verifier_detects_double_occupancy_via_tampered_seats(self):
        rid = self._ready_round()
        self._waive(rid, 1, "A003")
        pkg = self._export(rid)
        pkg["seats"] = ["A005", "A005", "A001"]  # 同一编号占两席
        proc = self._run_verifier(pkg)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("当前席位", proc.stdout)

    def test_legacy_package_without_waivers_still_verifies(self):
        """旧版包没有 waivers/seats 字段：按无弃权继续核验通过。"""
        rid = self._ready_round()
        pkg = self._export(rid)
        del pkg["waivers"]
        del pkg["seats"]
        proc = self._run_verifier(pkg)
        self.assertEqual(
            proc.returncode, 0,
            f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
        )
        self.assertIn("无弃权记录", proc.stdout)

    def test_sealed_package_unaffected(self):
        """封存未揭晓包的行为保持原样。"""
        rid = create_round(self.client, commitment=self.commitment)
        replace(self.client, rid, ["A001", "A002", "A003"])
        self.assertEqual(
            self.client.post(f"/api/rounds/{rid}/seal").status_code, 200
        )
        pkg = self._export(rid)
        self.assertIsNone(pkg["winners"])
        self.assertEqual(pkg["waivers"], [])
        self.assertIsNone(pkg["seats"])
        proc = self._run_verifier(pkg)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("封存（未揭晓）状态", proc.stdout)

    # ------------------------------------------------ 规则原语

    def test_next_winner_extends_permutation(self):
        entries = ["A001", "A002", "A003", "A004", "A005"]
        pool = sorted(entries, key=lambda e: e.encode())
        drawn = rules.draw_winners(entries, self.seed, 3)
        for d in drawn:
            pool.remove(d)
        # 排列第 3 轮（首个弃权续选）必须是 A002
        self.assertEqual(rules.next_winner(pool, self.seed, 3), "A002")


if __name__ == "__main__":
    unittest.main()
