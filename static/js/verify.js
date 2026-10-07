/* 浏览器内核验：逻辑与 verify/verify.py 对应，独立重算，不信任包内 winners。 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var out = $("verifyOut");

  function line(cls, html) {
    var div = document.createElement("div");
    div.className = "check-line check-" + cls;
    div.innerHTML = html;
    out.appendChild(div);
  }
  function heading(html) {
    var div = document.createElement("div");
    div.style.cssText = "margin:10px 0 4px;font-weight:700;";
    div.innerHTML = html;
    out.appendChild(div);
  }

  function hasDuplicates(arr) {
    return new Set(arr).size !== arr.length;
  }
  function duplicates(arr) {
    var seen = Object.create(null), ret = [];
    arr.forEach(function (x) {
      seen[x] = (seen[x] || 0) + 1;
    });
    Object.keys(seen).forEach(function (k) { if (seen[k] > 1) ret.push(k); });
    return ret;
  }

  function verifyPackage(pkg) {
    out.innerHTML = "";
    var failures = 0;
    function fail(msg) { failures++; line("fail", "✗ " + UI.esc(msg)); }
    function pass(msg) { line("pass", "✓ " + UI.esc(msg)); }
    function info(msg) { line("", UI.esc(msg)); }

    var rnd = pkg.round || {};
    heading("轮次：" + UI.esc(rnd.title || "?") + "（" + UI.esc(rnd.id || "?") + "）");
    info("状态：" + UI.esc(rnd.status) + "　名额：" + rnd.prizeCount +
         "　人数：" + (pkg.participantCount != null ? pkg.participantCount : "?"));
    heading("校验项");

    if (pkg.format !== "public-lottery-verification-v1") fail("format 字段不符：" + String(pkg.format));
    if (pkg.ruleId !== LotteryRules.RULE_ID) {
      fail("规则标识不符：" + String(pkg.ruleId) + "，本核验器只认 " + LotteryRules.RULE_ID);
    } else {
      pass("规则标识为 " + LotteryRules.RULE_ID);
    }

    var entries = pkg.participants;
    if (!Array.isArray(entries) || !entries.every(function (e) { return typeof e === "string"; })) {
      fail("participants 必须是字符串数组");
      return finish(failures);
    }

    var bad = entries.filter(function (e) {
      return !e.trim() || e !== e.trim() || e.indexOf("\n") >= 0 || e.indexOf("\r") >= 0;
    });
    if (bad.length) fail("名单含空编号/换行/未去首尾空白的编号：" + bad.slice(0, 5).join(", "));

    var dup = duplicates(entries);
    if (dup.length) fail("名单存在重复编号：" + dup.join(", "));

    var wantOrder = LotteryRules.canonicalSorted(entries);
    if (entries.length === wantOrder.length && entries.every(function (e, i) { return e === wantOrder[i]; })) {
      pass("名单为按 UTF-8 字节序排序的规范名单，且编号无重复");
    } else {
      var pos = 0;
      while (pos < entries.length && entries[pos] === wantOrder[pos]) pos++;
      fail("名单顺序不是规范的 UTF-8 字节序（首个偏差在第 " + (pos + 1) + " 项）");
    }

    var recalcDigest = LotteryRules.listDigest(entries);
    var extDigest = $("extDigest").value.trim().toLowerCase();
    var extCommit = $("extCommit").value.trim().toLowerCase();

    if (!rnd.listDigest) {
      fail("核验包缺少 listDigest（名单摘要）");
    } else if (recalcDigest !== rnd.listDigest.toLowerCase()) {
      fail("名单摘要不符：重算 " + recalcDigest + "；包内 " + rnd.listDigest);
    } else {
      pass("名单摘要核对一致：" + recalcDigest);
    }
    if (extDigest) {
      if (extDigest === recalcDigest && (!rnd.listDigest || extDigest === rnd.listDigest.toLowerCase())) {
        pass("与事先留存的名单摘要一致");
      } else {
        fail("事先留存的名单摘要不符：留存 " + extDigest + "；重算 " + recalcDigest);
      }
    }

    var commitment = (rnd.commitment || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(commitment)) fail("承诺不是 64 位十六进制");
    if (extCommit) {
      if (extCommit === commitment) pass("与事先留存的承诺一致");
      else fail("事先留存的承诺与包内承诺不符：留存 " + extCommit + "；包内 " + commitment);
    }

    var seed = rnd.seed ? rnd.seed.trim().toLowerCase() : null;
    var storedWaivers = Array.isArray(pkg.waivers) ? pkg.waivers : [];
    var storedSeats = pkg.seats;
    if (!seed) {
      heading("结论");
      if (rnd.status === "sealed") {
        info("该包处于封存（未揭晓）状态：承诺/名单摘要已核验，暂无种子与结果可校验。");
      } else {
        fail("包内无种子，但状态为 " + rnd.status + "（应为 sealed）");
      }
      return finish(failures);
    }

    if (!LotteryRules.isHex64(seed)) {
      fail("种子不是 64 位十六进制");
      return finish(failures);
    }
    var recalcCommit = LotteryRules.commitForSeed(seed);
    if (recalcCommit !== commitment) {
      fail("种子与承诺不匹配：重算 " + recalcCommit + "；包内承诺 " + commitment);
      return finish(failures);
    }
    pass("种子与承诺匹配：SHA256('COMMIT:'+seed) 与承诺一致");

    if (rnd.status !== "revealed") fail("包内有种子，但状态为 " + rnd.status + "（应为 revealed）");
    if (!(rnd.prizeCount > 0)) fail("中奖名额非法");
    if (rnd.prizeCount > entries.length) {
      fail("人数 " + entries.length + " 少于名额 " + rnd.prizeCount);
      return finish(failures);
    }
    if (dup.length) { fail("因名单重复，无法重算结果"); return finish(failures); }

    // 关键：独立重抽
    var recalc = LotteryRules.drawWinners(entries, seed, rnd.prizeCount);
    var stored = pkg.winners;
    var winnersMatch = false;
    if (!Array.isArray(stored)) {
      fail("核验包缺少 winners 数组");
    } else {
      if (stored.length !== rnd.prizeCount) fail("中奖数量 " + stored.length + " 不等于名额 " + rnd.prizeCount);
      if (hasDuplicates(stored)) fail("包内中奖编号存在重复");
      var outside = stored.filter(function (w) { return entries.indexOf(w) < 0; });
      if (outside.length) fail("包内中奖编号不在名单中：" + outside.join(", "));
      var same = stored.length === recalc.length && stored.every(function (w, i) { return w === recalc[i]; });
      if (!same) {
        var diffs = [];
        for (var i = 0; i < Math.max(stored.length, recalc.length); i++) {
          if (stored[i] !== recalc[i]) {
            diffs.push("第 " + (i + 1) + " 位：包内 " + stored[i] + "，重算 " + recalc[i]);
          }
        }
        fail("按公开规则由种子与名单重算的结果与包内结果不一致：\n" + diffs.slice(0, 20).join("\n"));
      } else {
        pass("按规则独立重算 " + rnd.prizeCount + " 个中奖编号，与包内结果完全一致");
        winnersMatch = true;
      }
    }

    heading("独立重算的原始中奖编号（按产生顺序，弃权不改变此顺序）");
    recalc.forEach(function (w, i) { info("  " + (i + 1) + ". " + w); });

    // ---- 弃权—递补链：只信 (seq,seat,waivedId)，递补全部由种子+名单重算 ----
    if (winnersMatch) {
      if (!Array.isArray(pkg.waivers)) {
        fail("waivers 字段不是数组");
      } else {
        heading("弃权—递补链独立重演");
        var sim = LotteryRules.replayWaivers(entries, seed, rnd.prizeCount, recalc, storedWaivers);
        sim.errors.forEach(function (msg) { fail("弃权链重演：" + msg); });

        sim.expected.forEach(function (item) {
          var w = item.record;
          var where = "弃权 seq=" + String(w.seq) + "（第 " + w.seat + " 席 " + w.waivedId + "）";
          if (w.drawIndex !== item.drawIndex) {
            fail(where + "的 drawIndex 跳过或伪造：包内 " + String(w.drawIndex) +
                 "，应为 " + String(item.drawIndex));
          }
          if ((w.replacementId == null ? null : w.replacementId) !== item.replacement) {
            fail(where + "的递补编号伪造：包内 " + String(w.replacementId) +
                 "，按规则续选应为 " + String(item.replacement));
          }
        });

        if (storedSeats == null) {
          if (storedWaivers.length) fail("核验包有弃权记录但缺少 seats（当前席位）字段");
        } else if (!Array.isArray(storedSeats)) {
          fail("seats 字段不是数组");
        } else if (storedSeats.length !== rnd.prizeCount) {
          fail("seats 数量 " + storedSeats.length + " 不等于名额 " + rnd.prizeCount);
        } else {
          var seatDiffs = [];
          for (var s = 0; s < rnd.prizeCount; s++) {
            var a = storedSeats[s] == null ? null : storedSeats[s];
            var b = sim.seats[s] == null ? null : sim.seats[s];
            if (a !== b) seatDiffs.push("第 " + (s + 1) + " 席：包内 " + String(a) + "，重演 " + String(b));
          }
          var occupied = sim.seats.filter(function (x) { return x != null; });
          if (seatDiffs.length) {
            fail("当前席位与弃权链独立重演结果不一致：\n" + seatDiffs.slice(0, 20).join("\n"));
          } else if (new Set(occupied).size !== occupied.length) {
            fail("重演结果中同一编号占用了多个席位");
          } else if (storedWaivers.length) {
            pass("弃权—递补链（" + storedWaivers.length + " 次弃权）独立重演通过，当前席位一致");
          }
        }

        if (storedWaivers.length) {
          sim.expected.forEach(function (item) {
            var w = item.record;
            var tail = item.replacement == null
              ? "→ 无候补，席位留空"
              : "→ 递补 " + item.replacement + "（排列第 " + item.drawIndex + " 轮）";
            info("#" + w.seq + "  第 " + w.seat + " 席 " + w.waivedId + " 弃权 " + tail);
          });
          info("当前席位：");
          sim.seats.forEach(function (x, idx) {
            info("  " + (idx + 1) + ". " + (x == null ? "（空席）" : x) +
                 "　原始中奖：" + recalc[idx]);
          });
        } else {
          info("无弃权记录：当前席位即原始中奖编号。");
        }
      }
    }
    return finish(failures);
  }

  function finish(failures) {
    heading("结论");
    if (failures) {
      line("fail", "发现 " + failures + " 处不符，核验未通过。");
    } else {
      line("pass", "全部核验通过。中奖结果由公开规则、种子与封存名单确定性地推出。");
    }
  }

  $("pkgFile").addEventListener("change", function () {
    var file = this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var pkg = JSON.parse(reader.result);
        verifyPackage(pkg);
      } catch (e) {
        out.innerHTML = "";
        line("fail", "无法解析 JSON：" + e.message + "（zip 请先解压，选择其中的 package.json）");
      }
    };
    reader.readAsText(file);
  });
})();
