/* 浏览器端的公开规则实现（与 app/rules.py、verify/verify.py 完全一致）。 */
(function (global) {
  "use strict";

  var RULE_ID = "sha256-argmax-v1";
  var COMMIT_PREFIX = "COMMIT:";

  function isHex64(s) {
    return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
  }

  // UTF-8 字节序比较（与 Python 的 key=lambda e: e.encode('utf-8') 一致）
  function compareUtf8(a, b) {
    var ba = Sha256.utf8Bytes(a);
    var bb = Sha256.utf8Bytes(b);
    var n = Math.min(ba.length, bb.length);
    for (var i = 0; i < n; i++) {
      if (ba[i] !== bb[i]) return ba[i] - bb[i];
    }
    return ba.length - bb.length;
  }

  function canonicalSorted(entries) {
    return entries.slice().sort(compareUtf8);
  }

  function canonicalSnapshot(entries) {
    return canonicalSorted(entries).join("\n");
  }

  function listDigest(entries) {
    return Sha256.hexFromString(canonicalSnapshot(entries));
  }

  function commitForSeed(seedHex) {
    return Sha256.hexFromString(COMMIT_PREFIX + seedHex.trim().toLowerCase());
  }

  function drawWinners(entries, seedHex, prizeCount) {
    if (!(prizeCount > 0) || prizeCount > entries.length) {
      throw new Error("名额必须满足 0 < 名额 <= 人数");
    }
    var pool = canonicalSorted(entries);
    var winners = [];
    for (var i = 0; i < prizeCount; i++) {
      var bestId = pickNext(pool, seedHex, i);
      winners.push(bestId);
      pool.splice(pool.indexOf(bestId), 1);
    }
    return winners;
  }

  // 既有排列在第 drawIndex 轮的下一个编号（揭晓后续选原语），
  // 与 drawWinners / app/rules.py / verify.py 使用完全相同的散列与平局规则。
  // pool 必须是“尚未出现”的规范有序编号集合且非空。
  function pickNext(pool, seedHex, drawIndex) {
    if (!pool.length) throw new Error("候选池为空");
    var bestId = null;
    var bestScore = null;
    for (var j = 0; j < pool.length; j++) {
      var msg = RULE_ID + "|" + seedHex + "|" + pool[j] + "|" + drawIndex;
      var digest = Sha256.hashBytes(Sha256.utf8Bytes(msg));
      var score = 0n;
      for (var k = 0; k < 32; k++) {
        score = (score << 8n) | BigInt(digest[k]);
      }
      if (bestScore === null || score > bestScore) {
        bestScore = score;
        bestId = pool[j];
      }
    }
    return bestId;
  }

  // 从种子与封存名单独立重演弃权—递补链。只信任每条记录声明的
  // (seq, seat[1 起], waivedId)；replacementId/drawIndex 一律重算，
  // 因此能指出伪造或跳过的递补。返回：
  // { errors:[], seats:[当前在任编号或 null], expected:[{record,replacement,drawIndex}] }
  function replayWaivers(entries, seedHex, prizeCount, winners, waivers) {
    var errors = [];
    var poolAll = canonicalSorted(entries);
    var seats = winners.slice();
    var appeared = Object.create(null);
    winners.forEach(function (w) { appeared[w] = true; });
    var expected = [];
    var filled = prizeCount;
    var prevSeq = 0;

    if (!Array.isArray(waivers)) {
      errors.push("waivers 字段不是数组");
      return { errors: errors, seats: seats, expected: expected };
    }

    waivers.forEach(function (w, idx) {
      var where = "第 " + (idx + 1) + " 条弃权记录";
      if (!w || typeof w !== "object") {
        errors.push(where + "不是对象");
        return;
      }
      var seq = w.seq, seatOne = w.seat, waived = w.waivedId;
      var seqOk = typeof seq === "number" && Math.floor(seq) === seq &&
        seq === prevSeq + 1;
      if (!seqOk) {
        errors.push(where + "的 seq 应为 " + (prevSeq + 1) +
          "（连续递增），包内为 " + String(seq));
      } else {
        prevSeq = seq;
      }

      if (typeof seatOne !== "number" || seatOne < 1 ||
          seatOne > prizeCount || Math.floor(seatOne) !== seatOne) {
        errors.push(where + "的 seat 名次非法：" + String(seatOne));
        expected.push({ record: w, replacement: null, drawIndex: null });
        return;
      }
      if (typeof waived !== "string" || poolAll.indexOf(waived) < 0) {
        errors.push(where + "的弃权编号不在封存名单中：" + String(waived));
        expected.push({ record: w, replacement: null, drawIndex: null });
        return;
      }

      var seat = seatOne - 1;
      var current = seats[seat];
      if (current !== waived) {
        errors.push(where + "（seq=" + String(seq) + "）声称第 " + seatOne +
          " 席由 " + waived + " 弃权，但重放的当前在任编号是 " +
          String(current) + "（非当前编号不可弃权）");
        expected.push({ record: w, replacement: null, drawIndex: null });
        return;
      }

      var remaining = poolAll.filter(function (e) { return !appeared[e]; });
      var rep = null, draw = null;
      if (remaining.length) {
        rep = pickNext(remaining, seedHex, filled);
        draw = filled;
        seats[seat] = rep;
        appeared[rep] = true;
        filled += 1;
      } else {
        seats[seat] = null; // 无候补：留空席，不占用 drawIndex
      }
      expected.push({ record: w, replacement: rep, drawIndex: draw });
    });

    return { errors: errors, seats: seats, expected: expected };
  }

  function generateSeed() {
    var bytes = new Uint8Array(32);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(bytes);
    } else {
      // 极端兜底（file:// 极旧环境）；正常现场环境不会走到
      for (var i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var hex = "";
    for (var j = 0; j < 32; j++) hex += bytes[j].toString(16).padStart(2, "0");
    return hex;
  }

  global.LotteryRules = {
    RULE_ID: RULE_ID,
    isHex64: isHex64,
    compareUtf8: compareUtf8,
    canonicalSorted: canonicalSorted,
    canonicalSnapshot: canonicalSnapshot,
    listDigest: listDigest,
    commitForSeed: commitForSeed,
    drawWinners: drawWinners,
    pickNext: pickNext,
    replayWaivers: replayWaivers,
    generateSeed: generateSeed,
  };
})(window);
