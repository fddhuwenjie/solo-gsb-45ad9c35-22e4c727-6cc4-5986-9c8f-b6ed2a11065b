/* 轮次页：名单增删/批量替换、封存、揭晓、导出核验包。 */
(function () {
  "use strict";
  var ROUND_ID = window.ROUND_ID;
  var $ = function (id) { return document.getElementById(id); };
  var flashEl = $("flash");
  var round = null;

  function statusLabel(s) {
    return { open: "登记中", sealed: "已封存", revealed: "已揭晓" }[s] || s;
  }

  function renderMeta() {
    $("roundTitle").textContent = round.title;
    $("meta").innerHTML =
      '<dt>轮次编号</dt><dd class="mono">' + UI.esc(round.id) + "</dd>" +
      "<dt>状态</dt><dd><span class='badge badge-" + round.status + "'>" + statusLabel(round.status) + "</span></dd>" +
      "<dt>中奖名额</dt><dd>" + round.prizeCount + "</dd>" +
      "<dt>承诺</dt><dd><div class='hash-box'>" + UI.esc(round.commitment) + "</div></dd>" +
      "<dt>创建时间</dt><dd class='mono'>" + UI.esc(round.createdAt || "") + "</dd>";
  }

  function renderOpenList() {
    var ps = round.participants || [];
    $("countOpen").textContent = ps.length;
    $("openList").innerHTML = ps.map(function (p, i) {
      return (
        "<tr><td class='rank muted'>" + (i + 1) + "</td>" +
        "<td class='mono'>" + UI.esc(p.id) + "</td>" +
        '<td><button class="secondary" data-del="' + UI.esc(p.id) + '">删除</button></td></tr>'
      );
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll("[data-del]"), function (btn) {
      btn.addEventListener("click", function () { removeEntry(btn.getAttribute("data-del")); });
    });
  }

  function renderSealPreview() {
    var ids = (round.participants || []).map(function (p) { return p.id; });
    var sorted = LotteryRules.canonicalSorted(ids);
    $("countSealText").textContent = ids.length;
    $("prizeSealText").textContent = round.prizeCount;
    $("previewSnapshot").textContent = sorted.join("\n");
    $("previewDigest").textContent = sorted.length
      ? LotteryRules.listDigest(ids)
      : "（名单为空）";
    $("sealBtn").disabled = ids.length < round.prizeCount;
  }

  function render() {
    renderMeta();
    var status = round.status;

    $("openCard").style.display = status === "open" ? "block" : "none";
    $("sealCard").style.display = status === "open" ? "block" : "none";
    $("sealedInfoCard").style.display = status !== "open" ? "block" : "none";
    $("revealCard").style.display = status === "sealed" ? "block" : "none";
    $("resultCard").style.display = status === "revealed" ? "block" : "none";
    $("exportCard").style.display = status !== "open" ? "block" : "none";

    if (status === "open") {
      renderOpenList();
      renderSealPreview();
    }

    if (status !== "open") {
      $("sealedDigest").textContent = round.listDigest || "";
      $("sealedAt").textContent = round.sealedAt || "";
      $("sealedCount").textContent = round.participantCount;
      $("sealedSnapshot").textContent = round.snapshot || "";
    }

    if (status === "sealed") {
      $("attemptsText").textContent =
        "此前承诺校验失败次数：" + (round.failedAttempts || 0) +
        "（失败不改变封存状态、不影响后续正确揭晓）";
    }

    if (status === "revealed") {
      $("resultSeed").textContent = round.seed;
      $("revealedAt").textContent = round.revealedAt || "";
      renderSeats();
      renderWaiverLog();
      renderLocalReplay();
    }

    var base = "/api/rounds/" + encodeURIComponent(round.id);
    $("zipLink").href = base + "/package.zip";
    $("jsonLink").href = base + "/package.json";
  }

  // ---------------- 弃权 / 递补

  function renderSeats() {
    var winners = round.winners || [];
    var seats = round.seats || winners.slice();
    $("seatList").innerHTML = winners.map(function (orig, i) {
      var cur = seats[i] == null ? null : seats[i];
      var changed = cur !== orig;
      var vacant = cur === null;
      var statusCell = vacant
        ? '<span class="seat-badge seat-vacant">空席（无候补）</span>'
        : changed
          ? '<span class="seat-badge seat-replaced">递补中</span>'
          : '<span class="seat-badge seat-orig">原始中奖</span>';
      var curCell = vacant
        ? '<span class="muted">— 空席 —</span>'
        : '<span class="mono' + (changed ? " tag-new" : "") + '">🏆 ' + UI.esc(cur) + "</span>";
      var btn = vacant
        ? '<button class="secondary" disabled title="空席不可操作">弃权</button>'
        : '<button class="danger" data-waive-seat="' + (i + 1) +
          '" data-waive-id="' + UI.esc(cur) + '">标记弃权</button>';
      return (
        "<tr><td class='rank'>" + (i + 1) + "</td>" +
        "<td class='mono muted'>" + UI.esc(orig) + "</td>" +
        "<td>" + curCell + "</td>" +
        "<td>" + statusCell + "</td>" +
        "<td>" + btn + "</td></tr>"
      );
    }).join("");

    Array.prototype.forEach.call(
      document.querySelectorAll("[data-waive-seat]"),
      function (btn) {
        btn.addEventListener("click", function () {
          waive(
            parseInt(btn.getAttribute("data-waive-seat"), 10),
            btn.getAttribute("data-waive-id")
          );
        });
      }
    );
  }

  function renderWaiverLog() {
    var waivers = round.waivers || [];
    $("waiverEmpty").style.display = waivers.length ? "none" : "block";
    $("waiverTable").style.display = waivers.length ? "table" : "none";
    $("waiverList").innerHTML = waivers.map(function (w) {
      var rep = w.replacementId == null
        ? '<span class="muted">无候补，留空</span>'
        : '<span class="mono tag-new">' + UI.esc(w.replacementId) + "</span>";
      var draw = w.drawIndex == null
        ? '<span class="muted">—</span>'
        : String(w.drawIndex);
      return (
        "<tr><td class='rank'>" + w.seq + "</td>" +
        "<td class='rank'>" + w.seat + "</td>" +
        "<td class='mono'>" + UI.esc(w.waivedId) + "</td>" +
        "<td>" + rep + "</td>" +
        "<td class='rank'>" + draw + "</td>" +
        "<td class='mono muted'>" + UI.esc(w.waivedAt || "") + "</td>" +
        "<td class='muted'>" + UI.esc(w.reason || "") + "</td></tr>"
      );
    }).join("");
  }

  // 浏览器端独立重演：只用种子 + 封存名单，不信任服务器的 seats/waivers 结果字段。
  function renderLocalReplay() {
    var out = $("replayOut");
    out.innerHTML = "";
    function line(cls, html) {
      var div = document.createElement("div");
      div.className = "check-line check-" + cls;
      div.innerHTML = html;
      out.appendChild(div);
    }
    try {
      var entries = (round.snapshot || "").split("\n").filter(function (s) {
        return s.length > 0;
      });
      var recalc = LotteryRules.drawWinners(entries, round.seed, round.prizeCount);
      var sim = LotteryRules.replayWaivers(
        entries, round.seed, round.prizeCount, recalc, round.waivers || []
      );
      var failures = sim.errors.slice();

      sim.expected.forEach(function (item) {
        var w = item.record;
        if (w.drawIndex !== item.drawIndex) {
          failures.push("弃权 seq=" + w.seq + " 的续选轮次被跳过/伪造：" +
            "包内 " + String(w.drawIndex) + "，应为 " + String(item.drawIndex));
        }
        var gotRep = w.replacementId == null ? null : w.replacementId;
        if (gotRep !== item.replacement) {
          failures.push("弃权 seq=" + w.seq + "（第 " + w.seat + " 席 " +
            w.waivedId + "）递补伪造：包内 " + String(gotRep) +
            "，应为 " + String(item.replacement));
        }
      });

      var serverSeats = round.seats || recalc.slice();
      sim.seats.forEach(function (s, i) {
        var a = serverSeats[i] == null ? null : serverSeats[i];
        if (a !== s) {
          failures.push("第 " + (i + 1) + " 席服务器当前编号 " + String(a) +
            " 与重演结果 " + String(s) + " 不一致");
        }
      });

      if (failures.length) {
        failures.forEach(function (m) { line("fail", "✗ " + UI.esc(m)); });
      } else {
        line("pass", "✓ 本机独立重演通过：原始中奖与全部递补均可由种子和封存名单推出。");
      }
      sim.seats.forEach(function (s, i) {
        line("", "第 " + (i + 1) + " 席：原始 " + UI.esc(recalc[i]) +
          " → 当前 " + (s == null ? "（空席）" : UI.esc(s)));
      });
    } catch (e) {
      line("fail", "✗ 重演失败：" + UI.esc(e.message));
    }
  }

  async function waive(seat, entryId) {
    var reason = prompt(
      "将第 " + seat + " 席当前有效中奖编号 " + entryId + " 标记弃权？\n" +
      "系统会按 sha256-argmax-v1 规则从封存名单中续选尚未出现的编号递补。\n" +
      "原始中奖顺序与揭晓时间保持不变。\n\n可填写弃权说明（可留空）：",
      ""
    );
    if (reason === null) return; // 取消
    try {
      var data = await UI.api(
        "/api/rounds/" + encodeURIComponent(ROUND_ID) + "/waivers",
        {
          method: "POST",
          body: JSON.stringify({ seat: seat, entryId: entryId, reason: reason }),
        }
      );
      UI.flash(flashEl, data.message || "弃权已登记", "ok");
      await refresh();
    } catch (e) {
      UI.flash(flashEl, e.message, "err");
      await refresh();
    }
  }

  async function refresh() {
    var data = await UI.api("/api/rounds/" + encodeURIComponent(ROUND_ID));
    round = data.round;
    render();
  }

  // ---------------- 名单操作（仅 open）

  async function addEntry() {
    var input = $("newId");
    var id = input.value.trim();
    if (!id) { UI.flash(flashEl, "请输入编号", "err"); return; }
    try {
      await UI.api("/api/rounds/" + encodeURIComponent(ROUND_ID) + "/participants", {
        method: "POST",
        body: JSON.stringify({ id: id }),
      });
      input.value = "";
      UI.clearFlash(flashEl);
      await refresh();
    } catch (e) { UI.flash(flashEl, e.message, "err"); }
  }

  async function removeEntry(id) {
    try {
      await UI.api(
        "/api/rounds/" + encodeURIComponent(ROUND_ID) + "/participants/" + encodeURIComponent(id),
        { method: "DELETE" }
      );
      await refresh();
    } catch (e) { UI.flash(flashEl, e.message, "err"); }
  }

  async function bulkReplace() {
    var ids = $("bulkIds").value.split("\n").map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length; });
    try {
      var data = await UI.api("/api/rounds/" + encodeURIComponent(ROUND_ID) + "/participants", {
        method: "PUT",
        body: JSON.stringify({ participants: ids }),
      });
      UI.flash(flashEl, "已整体替换名单，当前 " + data.count + " 人", "ok");
      $("bulkIds").value = "";
      await refresh();
    } catch (e) { UI.flash(flashEl, e.message, "err"); }
  }

  // ---------------- 封存

  async function seal() {
    var ids = (round.participants || []).map(function (p) { return p.id; });
    if (ids.length < round.prizeCount) {
      UI.flash(flashEl, "人数不足，不能封存", "err");
      return;
    }
    if (!confirm("封存后名单将不可修改。确认封存当前 " + ids.length + " 人的名单？")) return;
    try {
      await UI.api("/api/rounds/" + encodeURIComponent(ROUND_ID) + "/seal", { method: "POST" });
      UI.flash(flashEl, "名单已封存，快照与摘要已固定并展示。", "ok");
      await refresh();
    } catch (e) { UI.flash(flashEl, e.message, "err"); }
  }

  // ---------------- 揭晓

  async function reveal() {
    var seed = $("seedInput").value.trim().toLowerCase();
    if (!LotteryRules.isHex64(seed)) {
      UI.flash(flashEl, "种子必须是 64 位十六进制字符", "err");
      return;
    }
    // 浏览器端先做一次预判提示（最终以服务器校验为准）
    if (LotteryRules.commitForSeed(seed) !== round.commitment) {
      if (!confirm("本地预校验发现该种子与承诺不匹配。仍要提交吗？提交后轮次会保持封存状态。")) return;
    }
    try {
      var data = await UI.api("/api/rounds/" + encodeURIComponent(ROUND_ID) + "/reveal", {
        method: "POST",
        body: JSON.stringify({ seed: seed }),
      });
      if (data.alreadyRevealed) {
        UI.flash(flashEl, data.message, "warn");
      } else {
        UI.flash(flashEl, "承诺匹配，结果已一次性写入并永久固定。", "ok");
      }
      await refresh();
    } catch (e) {
      UI.flash(flashEl, e.message + (e.data && e.data.commitMismatch ? "" : ""), "err");
      await refresh();
    }
  }

  $("addBtn").addEventListener("click", addEntry);
  $("newId").addEventListener("keydown", function (e) { if (e.key === "Enter") addEntry(); });
  $("bulkBtn").addEventListener("click", bulkReplace);
  $("sealBtn").addEventListener("click", seal);
  $("revealBtn").addEventListener("click", reveal);

  refresh().catch(function (e) {
    UI.flash(flashEl, "加载轮次失败：" + e.message, "err");
  });
})();
