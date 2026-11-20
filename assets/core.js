/* =========================================================
   core.js — データの解析・時刻計算など、画面に依存しない処理
   ブラウザでは window.KR、Node.js では require() で使えます。
========================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KR = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAYS = ["月", "火", "水", "木", "金", "土", "日"];

  /* ---------------------------------------------------------
     文字列・時刻
  --------------------------------------------------------- */
  const pad2 = (n) => String(n).padStart(2, "0");
  const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";
  /** 全角英数・記号を半角にそろえて前後の空白を除く */
  const nfkc = (v) => (v === null || v === undefined ? "" : String(v).normalize("NFKC").trim());
  const plain = (v) => (v === null || v === undefined ? "" : String(v).trim());

  function fmtMin(m) {
    if (m === null || m === undefined || isNaN(m)) return "";
    return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
  }

  function fmtDuration(min) {
    min = Math.max(0, Math.round(min));
    if (min < 60) return min + "分";
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}時間${m}分` : `${h}時間`;
  }

  /**
   * いろいろな書き方の時刻を「0時からの分数」に変換する。読めなければ null。
   * 例: "9:00" "09:00:00" "9時" "9時半" "午後1時" "1:30 PM" "0930" 9 0.375(Excelの時刻)
   */
  function parseTime(v) {
    if (isBlank(v)) return null;
    if (typeof v === "number") {
      if (!isFinite(v) || v < 0) return null;
      if (Number.isInteger(v)) {
        if (v <= 24) return v * 60; // 9 → 9:00
        if (v >= 100 && v <= 2400 && v % 100 < 60) return Math.floor(v / 100) * 60 + (v % 100); // 930 → 9:30
        return null;
      }
      if (v < 1) return Math.round(v * 1440); // Excel の時刻（1日 = 1.0）
      if (v <= 24) return Math.round(v * 60); // 9.5 → 9:30
      return Math.round((v - Math.floor(v)) * 1440); // 日付つき時刻
    }
    if (v instanceof Date) return isNaN(v) ? null : v.getHours() * 60 + v.getMinutes();

    let s = nfkc(v).toLowerCase().replace(/\s+/g, "");
    if (!s) return null;
    let pm = false;
    let am = false;
    if (/午後|pm|p\.m\./.test(s)) { pm = true; s = s.replace(/午後|pm|p\.m\./g, ""); }
    if (/午前|am|a\.m\./.test(s)) { am = true; s = s.replace(/午前|am|a\.m\./g, ""); }
    s = s.replace(/時半$/, ":30").replace(/時/, ":").replace(/分$/, "").replace(/^(\d{1,2})\.(\d{2})$/, "$1:$2");

    let h, m, mt;
    if ((mt = /^(\d{1,2}):(\d{1,2})?(?::\d{1,2}(?:\.\d+)?)?$/.exec(s))) { h = +mt[1]; m = mt[2] ? +mt[2] : 0; }
    else if ((mt = /^(\d{3,4})$/.exec(s))) { h = Math.floor(+mt[1] / 100); m = +mt[1] % 100; }
    else if ((mt = /^(\d{1,2})$/.exec(s))) { h = +mt[1]; m = 0; }
    else return null;

    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
    return h * 60 + m;
  }

  const RANGE_SEP = /\s*(?:-|~|〜|–|—|ー|−|から|to)\s*/i;

  /** "9:00-10:30" "9時〜10時半" などの時間帯 → {start, end} */
  function parseTimeRange(v) {
    const s = nfkc(v);
    if (!s) return null;
    const parts = s.split(RANGE_SEP).filter(Boolean);
    if (parts.length !== 2) return null;
    const a = parseTime(parts[0]);
    const b = parseTime(parts[1].replace(/まで$/, ""));
    return a === null || b === null ? null : { start: a, end: b };
  }

  /** 時限の番号。名前に数字があればそれを使い、どの名前にも数字がない時だけ並び順を使う */
  function periodNo(p, i, periods) {
    const m = /\d+/.exec(nfkc(p.name));
    if (m) return +m[0];
    const anyDigit = (periods || []).some((x) => /\d/.test(nfkc(x.name)));
    return anyDigit ? null : i + 1;
  }

  /** "2限" "1-2限" "3,4限" "第5時限" など → {start, end}（periods の定義を使う） */
  function parsePeriodRef(v, periods) {
    if (!periods || !periods.length || isBlank(v)) return null;
    const s = nfkc(v);
    const exact = periods.find((p) => nfkc(p.name) === s);
    if (exact) return { start: exact.start, end: exact.end };
    const body = s.replace(/第|時限|限目|限|コマ目|コマ|period|目/gi, "");
    if (!/^[\d\s,、・~〜\-–—ー−から]+$/.test(body)) return null;
    const nums = (body.match(/\d+/g) || []).map(Number);
    if (!nums.length) return null;
    let list = nums;
    if (nums.length === 2 && /[~〜\-–—ー−]|から/.test(body)) {
      list = [];
      for (let n = Math.min(...nums); n <= Math.max(...nums); n++) list.push(n);
    }
    const found = list.map((n) => periods.find((p, i) => periodNo(p, i, periods) === n));
    if (found.some((f) => !f)) return null;
    return { start: Math.min(...found.map((f) => f.start)), end: Math.max(...found.map((f) => f.end)) };
  }

  /* ---------------------------------------------------------
     曜日・日付
  --------------------------------------------------------- */
  const EN_DAYS = [
    ["monday", "月"], ["tuesday", "火"], ["wednesday", "水"], ["thursday", "木"],
    ["friday", "金"], ["saturday", "土"], ["sunday", "日"],
    ["mon", "月"], ["tues", "火"], ["tue", "火"], ["wed", "水"], ["thurs", "木"],
    ["thu", "木"], ["fri", "金"], ["sat", "土"], ["sun", "日"],
  ];

  /**
   * 曜日の表記 → 曜日番号の配列（0=月 … 6=日）。読めなければ null。
   * 例: "月" "月曜日" "Mon" "月・水" "月,水,金" "月〜金" "平日" "毎日" "土日"
   */
  function parseDays(v) {
    let s = nfkc(v).toLowerCase();
    if (!s) return null;
    s = s.replace(/平日/g, "月火水木金").replace(/毎日|全日/g, "月火水木金土日").replace(/週末/g, "土日");
    for (const [en, ja] of EN_DAYS) s = s.split(en).join(ja);
    s = s.replace(/曜日|曜/g, "");
    s = s.replace(/([月火水木金土日])\s*(?:~|〜|-|–|—|ー|−|から)\s*([月火水木金土日])/g, (_, a, b) => {
      const ia = DAYS.indexOf(a);
      const ib = DAYS.indexOf(b);
      let out = "";
      for (let i = ia; ; i = (i + 1) % 7) { out += DAYS[i]; if (i === ib) break; }
      return out;
    });
    const rest = s.replace(/[月火水木金土日]/g, "").replace(/[\s,、，・\/&|()\[\]と及]/g, "");
    if (rest) return null;
    const set = new Set();
    for (const ch of s) { const i = DAYS.indexOf(ch); if (i >= 0) set.add(i); }
    return [...set].sort((a, b) => a - b);
  }

  const dateOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  /** 曜日番号（0=月 … 6=日） */
  const dayIndexOf = (d) => (d.getDay() + 6) % 7;
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s || "");
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
  }
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const startOfWeek = (d) => addDays(d, -dayIndexOf(d));
  const sameDay = (a, b) => ymd(a) === ymd(b);
  function fmtDate(d, withYear) {
    return (withYear ? d.getFullYear() + "/" : "") + (d.getMonth() + 1) + "/" + d.getDate() + "(" + DAYS[dayIndexOf(d)] + ")";
  }

  /** 日付の表記 → "YYYY-MM-DD"。例: "2026/11/20" "2026年11月20日" "11/20" Excelの日付 */
  function parseDate(v, refYear) {
    if (isBlank(v)) return null;
    if (v instanceof Date) return isNaN(v) ? null : ymd(v);
    if (typeof v === "number") {
      if (v < 20000 || v > 80000) return null;
      const d = new Date(Math.round((Math.floor(v) - 25569) * 86400000));
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    const s = nfkc(v).replace(/T.*$/, "").replace(/\(.*?\)/g, "").replace(/\s+/g, "");
    let m, y, mo, da;
    if ((m = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/.exec(s))) { y = +m[1]; mo = +m[2]; da = +m[3]; }
    else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) { y = +m[1]; mo = +m[2]; da = +m[3]; }
    else if ((m = /^(\d{1,2})[\/\-.月](\d{1,2})日?$/.exec(s))) {
      mo = +m[1];
      da = +m[2];
      if (refYear) y = refYear;
      else {
        // 年が書かれていない時は、今日から半年以内に収まる年とみなす
        const now = new Date();
        y = now.getFullYear();
        const diff = (new Date(y, mo - 1, da) - now) / 86400000;
        if (diff < -183) y++; else if (diff > 183) y--;
      }
    }
    else return null;
    const d = new Date(y, mo - 1, da);
    if (d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
    return ymd(d);
  }

  /* ---------------------------------------------------------
     見出し（列名）の判定
  --------------------------------------------------------- */
  const SCHEDULE_FIELDS = {
    room: ["部屋", "教室", "部屋名", "教室名", "場所", "会場", "room", "roomname", "place", "location"],
    day: ["曜日", "曜", "day", "weekday", "dow"],
    date: ["日付", "年月日", "日程", "実施日", "date"],
    start: ["開始", "開始時刻", "開始時間", "始", "start", "starttime", "from", "begin"],
    end: ["終了", "終了時刻", "終了時間", "終", "end", "endtime", "to", "finish"],
    time: ["時間", "時間帯", "時刻", "time", "timerange"],
    period: ["時限", "限", "コマ", "period"],
    title: ["内容", "授業名", "授業", "科目", "科目名", "用途", "件名", "タイトル", "名称", "予定", "title", "subject", "content", "course", "event"],
    owner: ["担当者", "担当", "担当教員", "教員", "先生", "利用者", "代表者", "予約者", "主催", "owner", "teacher", "instructor", "person"],
    note: ["備考", "メモ", "補足", "note", "notes", "memo", "comment", "remarks"],
    // クォーター名（CSV・JSON の書き出しで使う列。日付は「期間」シート側に書く）
    term: ["期間", "クォーター", "term", "quarter"],
  };
  const ROOM_FIELDS = {
    room: ["部屋", "教室", "部屋名", "教室名", "名前", "名称", "room", "name"],
    building: ["建物", "棟", "号館", "建屋", "場所", "building"],
    capacity: ["定員", "収容人数", "人数", "席数", "capacity", "seats"],
    note: ["備考", "設備", "メモ", "note", "equipment"],
  };
  const PERIOD_FIELDS = {
    name: ["時限", "名前", "名称", "限", "コマ", "name", "period"],
    start: SCHEDULE_FIELDS.start,
    end: SCHEDULE_FIELDS.end,
  };
  /* 「期間」シートの列。時間割の「開始」「終了」（時刻）とは別の名前で探す */
  const TERM_FIELDS = {
    name: ["シート", "シート名", "名前", "名称", "クォーター", "期間", "sheet", "name"],
    from: ["開始日", "期間開始", "from", "startdate"],
    to: ["終了日", "期間終了", "to", "enddate"],
  };

  const hkey = (h) => nfkc(h).toLowerCase().replace(/[\s_\-・:：()\[\]【】「」]/g, "");

  /** 見出し行 → { フィールド名: 列番号 }。完全一致を優先し、次に前方一致で探す */
  function mapHeader(row, fields) {
    const keys = (row || []).map(hkey);
    const map = {};
    const used = new Set();
    for (const pass of [0, 1]) {
      for (const [field, names] of Object.entries(fields)) {
        if (field in map) continue;
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (used.has(i) || !k) continue;
          const hit = names.some((n) => {
            const nk = hkey(n);
            if (pass === 0) return k === nk;
            // 前方一致は「開始時刻(HH:MM)」のような列名のため。英字の短い別名（to など）は完全一致のみ
            const ascii = /^[a-z0-9]+$/.test(nk);
            return (ascii ? nk.length >= 4 : nk.length >= 2) && k.startsWith(nk);
          });
          if (hit) { map[field] = i; used.add(i); break; }
        }
      }
    }
    return map;
  }

  function findHeader(aoa, fields, ok) {
    for (let r = 0; r < Math.min(aoa.length, 15); r++) {
      const map = mapHeader(aoa[r], fields);
      if (ok(map)) return { row: r, map };
    }
    return null;
  }

  /* ---------------------------------------------------------
     表データ → 予定
  --------------------------------------------------------- */
  let seq = 0;
  const newId = () => "e" + (++seq).toString(36) + Math.random().toString(36).slice(2, 7);

  function makeEntry(o) {
    return {
      id: o.id || newId(),
      room: o.room,
      day: o.day,
      date: o.date || null,
      start: o.start,
      end: o.end,
      title: o.title || "",
      owner: o.owner || "",
      note: o.note || "",
      row: o.row || null,
      term: o.term || null,         // クォーター名（「期間」シートのシート名）
      termFrom: o.termFrom || null, // その期間の開始日 "YYYY-MM-DD"
      termTo: o.termTo || null,     // その期間の終了日 "YYYY-MM-DD"
    };
  }

  const smallInt = (v) => /^\d{1,2}$/.test(nfkc(v)) && +nfkc(v) <= 7;

  function resolveTimes(get, periods) {
    const rs = get("start"), re = get("end"), rt = get("time"), rp = get("period");
    if (!isBlank(rs) && !isBlank(re)) {
      const pa = parsePeriodRef(rs, periods);
      const pb = parsePeriodRef(re, periods);
      // 開始「1」終了「2」のような小さな数だけの時は時限とみなす（1時〜2時の授業はまずないため）
      if (pa && pb && smallInt(rs) && smallInt(re)) return { start: pa.start, end: pb.end };
      const a = parseTime(rs);
      // Excel では 24:00 が数値の 1 として保存される
      const b = re === 1 && typeof rs === "number" && rs < 1 ? 1440 : parseTime(re);
      if (a !== null && b !== null) return { start: a, end: b };
      if (pa && pb) return { start: pa.start, end: pb.end };
      return null;
    }
    // 「時限」列は時限として、「時間」列は時間帯として先に読む
    const tries = [[rp, true], [rt, false], [rs, false]];
    for (const [v, periodFirst] of tries) {
      if (isBlank(v)) continue;
      const asRange = () => (typeof v === "string" ? parseTimeRange(v) : null);
      const asPeriod = () => parsePeriodRef(v, periods);
      const r = periodFirst ? asPeriod() || asRange() : asRange() || asPeriod();
      if (r) return r;
    }
    return null;
  }

  /**
   * 時間割の表（2次元配列）を解析する。
   * @param {Array[]} aoa 行の配列
   * @param {{periods?:Array, offset?:number, sheet?:string, refYear?:number}} opts
   *        offset はシート上の先頭行番号のずれ（エラー表示の行番号用）
   */
  function parseSchedule(aoa, opts = {}) {
    const periods = opts.periods || [];
    const offset = opts.offset || 0;
    const sheet = opts.sheet || "";
    const entries = [];
    const issues = [];
    const hd = findHeader(aoa, SCHEDULE_FIELDS, (m) => "room" in m && ("day" in m || "date" in m));
    if (!hd) {
      issues.push({ level: "error", sheet, msg: "見出し行（「部屋」「曜日」などの列名）が見つかりません" });
      return { entries, issues, ok: false };
    }
    const { row: hr, map } = hd;
    for (let r = hr + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      if (row.every(isBlank)) continue;
      const line = r + 1 + offset;
      const get = (f) => (f in map ? row[map[f]] : "");
      const err = (msg) => issues.push({ level: "error", sheet, row: line, msg });

      const room = nfkc(get("room"));
      if (!room) { err("部屋が空欄のため読み飛ばしました"); continue; }

      let date = null;
      if (!isBlank(get("date"))) {
        date = parseDate(get("date"), opts.refYear);
        if (!date) { err(`日付「${plain(get("date"))}」を読み取れません`); continue; }
      }

      let days = [];
      const rawDay = plain(get("day"));
      if (rawDay) {
        const d = parseDays(rawDay);
        if (d && d.length) days = d;
        else if (!date) { err(`曜日「${rawDay}」を読み取れません（例: 月、火曜日、月・水、月〜金）`); continue; }
      }
      if (date) {
        const di = dayIndexOf(parseYmd(date));
        if (days.length && !days.includes(di)) {
          issues.push({ level: "warn", sheet, row: line, msg: `曜日「${rawDay}」と日付 ${date}（${DAYS[di]}）が合わないため、日付を優先しました` });
        }
      } else if (!days.length) { err("曜日（または日付）が空欄です"); continue; }

      const t = resolveTimes(get, periods);
      if (!t) {
        const cells = ["start", "end", "time", "period"].filter((f) => f in map && !isBlank(get(f)))
          .map((f) => `「${plain(get(f))}」`).join(" ");
        err(`時間を読み取れません${cells ? " " + cells : "（開始・終了が空欄）"}`);
        continue;
      }
      if (t.end <= t.start) { err(`終了 ${fmtMin(t.end)} が開始 ${fmtMin(t.start)} より前になっています`); continue; }

      const base = { room, start: t.start, end: t.end, title: plain(get("title")), owner: plain(get("owner")), note: plain(get("note")), row: line, term: plain(get("term")) || null };
      if (date) entries.push(makeEntry({ ...base, date, day: dayIndexOf(parseYmd(date)) }));
      else days.forEach((day) => entries.push(makeEntry({ ...base, day })));
    }
    return { entries, issues, ok: true };
  }

  /** 部屋一覧の表 → [{name, building, capacity, note}] */
  function parseRooms(aoa, opts = {}) {
    const hd = findHeader(aoa, ROOM_FIELDS, (m) => "room" in m);
    // 時間割の表を誤って部屋一覧として読まないようにする
    if (!hd || "day" in mapHeader(aoa[hd.row], SCHEDULE_FIELDS)) return { rooms: [], issues: [] };
    const rooms = [];
    const issues = [];
    const seen = new Set();
    for (let r = hd.row + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const get = (f) => (f in hd.map ? row[hd.map[f]] : "");
      const name = nfkc(get("room"));
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const capRaw = nfkc(get("capacity")).replace(/[人名席]/g, "");
      const cap = capRaw === "" ? null : Number(capRaw);
      if (capRaw !== "" && !isFinite(cap)) issues.push({ level: "warn", sheet: opts.sheet, row: r + 1 + (opts.offset || 0), msg: `定員「${capRaw}」を数値として読めません` });
      rooms.push({ name, building: plain(get("building")), capacity: isFinite(cap) ? cap : null, note: plain(get("note")) });
    }
    return { rooms, issues };
  }

  /** 時限の表 → [{name, start, end}] */
  function parsePeriods(aoa, opts = {}) {
    const hd = findHeader(aoa, PERIOD_FIELDS, (m) => "name" in m && "start" in m && "end" in m);
    if (!hd || "room" in mapHeader(aoa[hd.row], SCHEDULE_FIELDS)) return { periods: [], issues: [] };
    const periods = [];
    const issues = [];
    for (let r = hd.row + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const get = (f) => (f in hd.map ? row[hd.map[f]] : "");
      const name = plain(get("name"));
      if (!name) continue;
      const start = parseTime(get("start"));
      const end = parseTime(get("end"));
      if (start === null || end === null || end <= start) {
        issues.push({ level: "warn", sheet: opts.sheet, row: r + 1 + (opts.offset || 0), msg: `時限「${name}」の時刻を読み取れません` });
        continue;
      }
      periods.push({ name, start, end });
    }
    return { periods, issues };
  }

  /** 「期間」の表 → [{name, from, to}]（from・to は "YYYY-MM-DD"） */
  function parseTermTable(aoa, opts = {}) {
    const sheet = opts.sheet || "";
    const terms = [];
    const issues = [];
    const hd = findHeader(aoa || [], TERM_FIELDS, (m) => "name" in m && "from" in m && "to" in m);
    if (!hd) {
      if ((aoa || []).some((r) => (r || []).some((c) => !isBlank(c)))) {
        issues.push({ level: "warn", sheet, msg: "「シート」「開始日」「終了日」の見出し行が見つからないため、期間の設定を読み飛ばしました" });
      }
      return { terms, issues };
    }
    for (let r = hd.row + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const get = (f) => (f in hd.map ? row[hd.map[f]] : "");
      const name = plain(get("name"));
      if (!name) continue;
      const line = r + 1 + (opts.offset || 0);
      const warn = (msg) => issues.push({ level: "warn", sheet, row: line, msg });
      const from = parseDate(get("from"));
      const to = parseDate(get("to"));
      if (!from || !to) { warn(`期間「${name}」の開始日・終了日を読み取れません（例: 2026/10/01）`); continue; }
      if (to < from) { warn(`期間「${name}」の終了日 ${to} が開始日 ${from} より前になっています`); continue; }
      if (terms.some((t) => hkey(t.name) === hkey(name))) { warn(`期間「${name}」が2回書かれています（最初の行を使います）`); continue; }
      const dup = terms.find((t) => t.from <= to && from <= t.to);
      if (dup) warn(`期間「${name}」と「${dup.name}」の日付が重なっています`);
      terms.push({ name, from, to });
    }
    return { terms, issues };
  }

  /** 名前の書き方の違い（全角・半角、空白など）を無視して一致するものを探す */
  const findByName = (list, name, key = (x) => x) =>
    list.find((x) => key(x) === name) || list.find((x) => hkey(key(x)) === hkey(name));

  /** 期間の一覧に合わせて、予定の termFrom / termTo を設定し直す（一覧にない期間名は日付なし＝いつでも有効） */
  function applyTerms(entries, terms) {
    (entries || []).forEach((e) => {
      const t = e.term ? findByName(terms || [], e.term, (x) => x.name) : null;
      if (t) e.term = t.name;
      e.termFrom = t ? t.from : null;
      e.termTo = t ? t.to : null;
    });
    return entries;
  }

  /**
   * 複数の表（時間割・部屋・時限・期間）をまとめて解析する。
   * tables = { schedule?:{aoa, offset, name}, rooms?:{...}, periods?:{...},
   *            terms?:{...}（「期間」の表）, sheets?:{ シート名: {aoa, offset, name} } }
   * sheets があれば、期間の表に書かれた各シートを時間割として読み、予定に期間を付ける（クォーター）。
   * sheets がなく terms だけの時（JSON など）は、予定の「期間」列の名前に日付を当てはめる。
   */
  function parseTables(tables, opts = {}) {
    const issues = [];
    let periods = [];
    if (tables.periods) {
      const p = parsePeriods(tables.periods.aoa, { sheet: tables.periods.name, offset: tables.periods.offset });
      periods = p.periods;
      issues.push(...p.issues);
    }
    let rooms = [];
    if (tables.rooms) {
      const r = parseRooms(tables.rooms.aoa, { sheet: tables.rooms.name, offset: tables.rooms.offset });
      rooms = r.rooms;
      issues.push(...r.issues);
    }
    let terms = [];
    const termIssues = [];
    if (tables.terms) {
      const t = parseTermTable(tables.terms.aoa, { sheet: tables.terms.name, offset: tables.terms.offset });
      terms = t.terms;
      termIssues.push(...t.issues);
    }
    const schedOpts = (tb) => ({
      periods: periods.length ? periods : opts.defaultPeriods || [],
      offset: tb.offset,
      sheet: tb.name,
      refYear: opts.refYear,
    });

    const entries = [];
    const schedIssues = [];
    const termMode = !!(tables.sheets && terms.length);
    if (termMode) {
      let okCount = 0;
      let firstError = null;
      const readSheet = (tb, term) => {
        const sch = parseSchedule(tb.aoa, schedOpts(tb));
        schedIssues.push(...sch.issues);
        if (!sch.ok) { firstError = firstError || `「${tb.name}」: ${sch.issues[0].msg}`; return; }
        okCount++;
        if (term) {
          sch.entries.forEach((e) => {
            e.term = term.name;
            e.termFrom = term.from;
            e.termTo = term.to;
            if (e.date && (e.date < term.from || e.date > term.to)) {
              schedIssues.push({ level: "warn", sheet: tb.name, row: e.row, msg: `日付 ${e.date} が期間「${term.name}」（${term.from}〜${term.to}）の外にあるため、表示されません` });
            }
          });
        }
        entries.push(...sch.entries);
      };
      // 期間の表に書かれたシートを順に読む（見つからないシートは注意を出して飛ばす）
      const names = Object.keys(tables.sheets).filter((n) => tables.sheets[n]);
      const found = [];
      terms.forEach((t) => {
        const n = findByName(names, t.name);
        if (!n) {
          termIssues.push({ level: "warn", sheet: tables.terms.name, msg: `期間「${t.name}」のシートが見つからないため読み飛ばしました（シート名を確認してください）` });
          return;
        }
        if (found.some((f) => f.name === n)) return;
        found.push({ ...t, name: n });
      });
      terms = found;
      terms.forEach((t) => readSheet(tables.sheets[t.name], t));
      // 期間の表に書かれていない「時間割」シートは、すべての期間に共通の予定として読む
      if (tables.schedule && !terms.some((t) => t.name === tables.schedule.name)) readSheet(tables.schedule, null);
      if (!okCount) throw new Error(firstError || "時間割のシートが見つかりません");
    } else {
      const s = tables.schedule || { aoa: [] };
      const sch = parseSchedule(s.aoa, schedOpts(s));
      if (!sch.ok) throw new Error(sch.issues[0].msg);
      entries.push(...sch.entries);
      schedIssues.push(...sch.issues);
      if (terms.length) applyTerms(entries, terms);
    }
    issues.unshift(...schedIssues, ...termIssues);
    return { entries, rooms, periods, terms, issues };
  }

  const SHEET_NAMES = {
    schedule: ["時間割", "予定", "スケジュール", "schedule", "timetable"],
    rooms: ["部屋", "部屋一覧", "教室一覧", "rooms"],
    periods: ["時限", "時限設定", "periods"],
    terms: ["期間", "クォーター", "学期", "terms"],
  };

  /** SheetJS のワークブック → 解析結果 */
  function parseWorkbook(wb, XLSX, opts = {}) {
    const table = (name) => {
      if (!name) return null;
      const ws = wb.Sheets[name];
      if (!ws || !ws["!ref"]) return null;
      const offset = XLSX.utils.decode_range(ws["!ref"]).s.r;
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "", blankrows: true });
      return { aoa, offset, name };
    };
    const byName = (names) => wb.SheetNames.find((n) => names.some((x) => hkey(n) === hkey(x)));
    const roomsName = byName(SHEET_NAMES.rooms);
    const periodsName = byName(SHEET_NAMES.periods);

    // 「期間」シートがあり、そこに書かれたシートが1つでもあれば、クォーターごとのシートを読む
    const termName = byName(SHEET_NAMES.terms);
    let termTables = null;
    const extra = [];
    if (termName) {
      const tt = table(termName);
      const pre = tt ? parseTermTable(tt.aoa) : { terms: [] };
      const others = wb.SheetNames.filter((n) => n !== termName && n !== roomsName && n !== periodsName);
      const sheets = {};
      pre.terms.forEach((t) => { const n = findByName(others, t.name); if (n && !sheets[n]) sheets[n] = table(n); });
      if (Object.values(sheets).some(Boolean)) termTables = { terms: tt, sheets };
      else if (pre.terms.length) extra.push({ level: "warn", sheet: termName, msg: "「期間」シートに書かれたシートが見つからないため、期間の設定は使わずに読み込みました" });
    }

    let schedName = byName(SHEET_NAMES.schedule);
    if (termTables && schedName && termTables.sheets[schedName]) schedName = null;
    if (!schedName && !termTables) {
      schedName = wb.SheetNames.find((n) => {
        if (n === termName) return false;
        const t = table(n);
        return t && findHeader(t.aoa, SCHEDULE_FIELDS, (m) => "room" in m && ("day" in m || "date" in m));
      });
    }
    if (!schedName && !termTables) throw new Error("時間割のシートが見つかりません（「部屋」「曜日」「開始」「終了」の列がある表を用意してください）");
    const res = parseTables({
      schedule: table(schedName),
      rooms: table(roomsName),
      periods: table(periodsName),
      ...(termTables || {}),
    }, opts);
    res.issues.push(...extra);
    return res;
  }

  /** CSV / TSV（Excel やスプレッドシートからの貼り付け）→ 2次元配列 */
  function parseDelimited(text) {
    text = String(text || "").replace(/^﻿/, "");
    // 区切り文字は先頭の数行から判定（1行目がタイトルだけの場合に備える）
    const head = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
    const count = (ch) => head.reduce((n, l) => n + l.split(ch).length - 1, 0);
    const delim = count("\t") > 0 ? "\t" : count(";") > count(",") ? ";" : ",";
    // 引用符で始まるセルが正しく閉じているか先読みする（閉じていなければ普通の文字として扱う）
    const closes = (from) => {
      for (let j = from; j < text.length; j++) {
        if (text[j] !== '"') continue;
        if (text[j + 1] === '"') { j++; continue; }
        const nx = text[j + 1];
        return nx === undefined || nx === delim || nx === "\n" || nx === "\r";
      }
      return false;
    };
    const rows = [];
    let row = [];
    let cell = "";
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === "" && closes(i + 1)) q = true;
      else if (c === delim) { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /** JSON（このアプリの書き出し形式、またはオブジェクトの配列）→ 表 */
  function jsonToTables(obj) {
    const toAoa = (arr) => {
      const keys = [];
      arr.forEach((o) => Object.keys(o || {}).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
      return [keys, ...arr.map((o) => keys.map((k) => (o && o[k] !== undefined && o[k] !== null ? o[k] : "")))];
    };
    if (Array.isArray(obj)) return { schedule: { aoa: toAoa(obj), offset: 0, name: "" } };
    if (obj && typeof obj === "object") {
      const list = obj.entries || obj.schedule;
      if (!Array.isArray(list)) throw new Error("JSON に entries（予定の配列）がありません");
      return {
        schedule: { aoa: toAoa(list), offset: 0, name: "entries" },
        rooms: Array.isArray(obj.rooms) ? { aoa: toAoa(obj.rooms), offset: 0, name: "rooms" } : null,
        periods: Array.isArray(obj.periods) ? { aoa: toAoa(obj.periods), offset: 0, name: "periods" } : null,
        terms: Array.isArray(obj.terms) && obj.terms.length ? { aoa: toAoa(obj.terms), offset: 0, name: "terms" } : null,
      };
    }
    throw new Error("JSON の形式が正しくありません");
  }

  /* ---------------------------------------------------------
     予定の計算
  --------------------------------------------------------- */
  /** 部屋一覧（定義順）＋予定にだけ出てくる部屋（出現順） */
  function compileRooms(meta, entries) {
    const map = new Map();
    (meta || []).forEach((r) => {
      if (r && r.name && !map.has(r.name)) map.set(r.name, { name: r.name, building: r.building || "", capacity: r.capacity ?? null, note: r.note || "" });
    });
    entries.forEach((e) => { if (!map.has(e.room)) map.set(e.room, { name: e.room, building: "", capacity: null, note: "" }); });
    return [...map.values()];
  }

  /** 「休講」「中止」などで始まる日付指定の予定は、その時間の定期予定を取り消す */
  const CANCEL_RE = /^(休講|中止|取消|取り消し|キャンセル|休止)/;
  const isCancel = (e) => !!e.date && CANCEL_RE.test(e.title || "");

  /* ---------------------------------------------------------
     期間（クォーター）
  --------------------------------------------------------- */
  const toYmd = (d) => (d instanceof Date ? ymd(d) : d);
  /** 予定 e がその日 ds（"YYYY-MM-DD"）の期間に入っているか。期間のない予定はいつでも有効 */
  const inTerm = (e, ds) => (!e.termFrom || e.termFrom <= ds) && (!e.termTo || ds <= e.termTo);
  /** 2つの予定の期間が重なるか（期間のない予定はすべてと重なる） */
  const termsOverlap = (a, b) =>
    (!a.termFrom || !b.termTo || a.termFrom <= b.termTo) && (!b.termFrom || !a.termTo || b.termFrom <= a.termTo);

  /** その日（Date か "YYYY-MM-DD"）を含む期間の一覧 */
  function termsOn(terms, date) {
    const ds = toYmd(date);
    return (terms || []).filter((t) => t.from <= ds && ds <= t.to);
  }
  /** その日を含む期間（なければ null） */
  const termFor = (terms, date) => termsOn(terms, date)[0] || null;
  /** その日の期間と、直前に終わった期間・次に始まる期間 → {current, prev, next} */
  function termContext(terms, date) {
    const ds = toYmd(date);
    let prev = null;
    let next = null;
    (terms || []).forEach((t) => {
      if (t.to < ds && (!prev || t.to > prev.to)) prev = t;
      if (t.from > ds && (!next || t.from < next.from)) next = t;
    });
    return { current: termFor(terms, ds), prev, next };
  }
  /** "2026-10-01" → "10/1"（withYear で "2026/10/1"） */
  function fmtYmd(s, withYear) {
    const d = parseYmd(s);
    return d ? (withYear ? d.getFullYear() + "/" : "") + (d.getMonth() + 1) + "/" + d.getDate() : "";
  }
  /** 期間の表示名 → "3Q（10/1〜11/30）" */
  const termLabel = (t, withYear) => (t ? `${t.name}（${fmtYmd(t.from, withYear)}〜${fmtYmd(t.to, withYear)}）` : "");

  /**
   * 指定した日の予定（開始順）。
   * withCancelled: true なら休講になった定期予定も cancelled:true を付けて含める
   */
  function entriesOn(entries, date, opt = {}) {
    const ds = ymd(date);
    const di = dayIndexOf(date);
    // 期間（クォーター）の外の予定は除く
    const todays = entries.filter((e) => (e.date ? e.date === ds : e.day === di) && inTerm(e, ds));
    const cancels = todays.filter(isCancel);
    const out = [];
    for (const e of todays) {
      if (isCancel(e)) continue;
      const cancelled = !e.date && cancels.some((c) => c.room === e.room && c.start < e.end && e.start < c.end);
      if (cancelled) { if (opt.withCancelled) out.push({ ...e, cancelled: true }); continue; }
      out.push(e);
    }
    const sorted = out.sort((a, b) => a.start - b.start || a.end - b.end);
    return opt.merge === false ? sorted : mergeConsecutive(sorted);
  }

  /**
   * 同じ部屋・同じ内容・同じ担当者で、休み時間（maxGap 分以内）をはさんで続く予定を1つにまとめる。
   * 時限ごとに行が分かれているデータ（3限・4限の実験など）を1つのブロックとして見せるため。
   * 昼休みのように間が長いものはまとめない（その間は空き部屋として扱う）。
   * まとめた予定には元の予定の id の一覧 partIds が付く。
   */
  function mergeConsecutive(list, maxGap = 10) {
    const out = [];
    const lastBy = new Map();
    for (const e of [...list].sort((a, b) => a.start - b.start || a.end - b.end)) {
      const key = [e.room, e.title, e.owner, e.date || "", e.day, e.cancelled ? 1 : 0, e.term || ""].join("\u0000");
      const last = lastBy.get(key);
      if (last && e.start >= last.end && e.start - last.end <= maxGap) {
        last.end = Math.max(last.end, e.end);
        last.partIds.push(e.id);
        continue;
      }
      const m = { ...e, partIds: [e.id] };
      out.push(m);
      lastBy.set(key, m);
    }
    return out;
  }

  /** 部屋のその時刻の状態: busy(使用中) / soon(まもなく) / free(空き) */
  function roomStatus(dayList, room, min, soon = 15) {
    const mine = dayList.filter((e) => e.room === room && !e.cancelled);
    const current = mine.filter((e) => e.start <= min && min < e.end);
    if (current.length) {
      let until = Math.max(...current.map((e) => e.end));
      for (let changed = true; changed;) {
        changed = false;
        for (const e of mine) if (e.start <= until && e.end > until) { until = e.end; changed = true; }
      }
      const next = mine.find((e) => !current.includes(e) && e.start > min) || null;
      return { state: "busy", current, next, busyUntil: until };
    }
    const next = mine.find((e) => e.start > min) || null;
    if (next && next.start - min <= soon) return { state: "soon", current, next, freeUntil: next.start };
    return { state: "free", current, next, freeUntil: next ? next.start : null };
  }

  /** from〜to のうち空いている時間帯 [[開始, 終了], ...] */
  function freeIntervals(dayList, room, from, to) {
    const busy = dayList
      .filter((e) => e.room === room && !e.cancelled && e.start < to && e.end > from)
      .map((e) => [Math.max(e.start, from), Math.min(e.end, to)])
      .sort((a, b) => a[0] - b[0]);
    const out = [];
    let cur = from;
    for (const [s, e] of busy) { if (s > cur) out.push([cur, s]); cur = Math.max(cur, e); }
    if (cur < to) out.push([cur, to]);
    return out;
  }

  /** 時間が重なる予定を横に並べるためのレーン割り当て → Map(item → {lane, lanes}) */
  function assignLanes(items) {
    const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
    const res = new Map();
    let cluster = [];
    let laneEnds = [];
    let clusterEnd = -1;
    const flush = () => { cluster.forEach((it) => { res.get(it).lanes = laneEnds.length; }); cluster = []; laneEnds = []; };
    for (const it of sorted) {
      if (cluster.length && it.start >= clusterEnd) flush();
      let lane = laneEnds.findIndex((end) => end <= it.start);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(it.end); } else laneEnds[lane] = it.end;
      res.set(it, { lane, lanes: 1 });
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.end);
    }
    flush();
    return res;
  }

  /** 毎週の予定 w が、その日 date の休講で取り消されているか */
  function cancelledOnDate(entries, w, date) {
    return !w.date && entries.some((c) => isCancel(c) && c.date === date && c.room === w.room && c.start < w.end && w.start < c.end);
  }

  /** a と b が同じ日・同じ部屋で時間が重なるか（休講で取り消された分は除く） */
  function clash(entries, a, b) {
    if (a.room !== b.room || isCancel(a) || isCancel(b)) return false;
    if (!(a.start < b.end && b.start < a.end)) return false;
    // 期間（クォーター）が重ならなければ、同じ曜日・時間でもぶつからない
    if (!termsOverlap(a, b)) return false;
    if (a.date && !inTerm(b, a.date)) return false;
    if (b.date && !inTerm(a, b.date)) return false;
    if (a.date && b.date) return a.date === b.date;
    if (a.day !== b.day) return false;
    if (a.date && cancelledOnDate(entries, b, a.date)) return false;
    if (b.date && cancelledOnDate(entries, a, b.date)) return false;
    return true;
  }

  /** 同じ部屋で時間が重なっている予定の組 */
  function findConflicts(entries) {
    const byRoom = new Map();
    entries.forEach((e) => { if (!isCancel(e)) { if (!byRoom.has(e.room)) byRoom.set(e.room, []); byRoom.get(e.room).push(e); } });
    const out = [];
    for (const list of byRoom.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (clash(entries, list[i], list[j])) out.push([list[i], list[j]]);
        }
      }
    }
    return out;
  }

  /** 新しい予定 cand と重なる既存の予定（ignoreIds は除外） */
  function overlapsWith(entries, cand, ignoreIds = []) {
    return entries.filter((e) => !ignoreIds.includes(e.id) && clash(entries, e, { title: "", ...cand }));
  }

  /* ---------------------------------------------------------
     書き出し
  --------------------------------------------------------- */
  const SCHEDULE_HEADERS = ["部屋", "曜日", "日付", "開始", "終了", "内容", "担当者", "備考"];

  function sortEntries(entries, roomOrder = []) {
    const idx = new Map(roomOrder.map((r, i) => [r, i]));
    const ri = (r) => (idx.has(r) ? idx.get(r) : 1e6);
    return [...entries].sort((a, b) =>
      ri(a.room) - ri(b.room) || a.room.localeCompare(b.room, "ja", { numeric: true }) ||
      (a.date ? 1 : 0) - (b.date ? 1 : 0) || (a.date || "").localeCompare(b.date || "") ||
      a.day - b.day || a.start - b.start);
  }

  /** opt.term: true なら最後に「期間」列を付ける（CSV 用） */
  function toScheduleAoa(entries, roomOrder, opt = {}) {
    const head = opt.term ? [...SCHEDULE_HEADERS, "期間"] : SCHEDULE_HEADERS;
    return [head, ...sortEntries(entries, roomOrder).map((e) => {
      const row = [e.room, DAYS[e.day], e.date || "", fmtMin(e.start), fmtMin(e.end), e.title, e.owner, e.note];
      if (opt.term) row.push(e.term || "");
      return row;
    })];
  }
  const slashDate = (s) => String(s || "").replace(/-/g, "/");
  /** 「期間」シート（シート / 開始日 / 終了日） */
  const toTermsAoa = (terms) => [["シート", "開始日", "終了日"], ...terms.map((t) => [t.name, slashDate(t.from), slashDate(t.to)])];
  const toRoomsAoa = (rooms) => [["部屋", "建物", "定員", "備考"], ...rooms.map((r) => [r.name, r.building || "", r.capacity ?? "", r.note || ""])];
  const toPeriodsAoa = (periods) => [["時限", "開始", "終了"], ...periods.map((p) => [p.name, fmtMin(p.start), fmtMin(p.end)])];

  function toCSV(aoa) {
    const cell = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return "﻿" + aoa.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  function toJSON(entries, rooms, periods, terms = []) {
    const out = {
      entries: sortEntries(entries, rooms.map((r) => r.name)).map((e) => {
        const o = {
          room: e.room, day: DAYS[e.day], date: e.date || "", start: fmtMin(e.start), end: fmtMin(e.end),
          title: e.title, owner: e.owner, note: e.note,
        };
        if (terms.length) o.term = e.term || "";
        return o;
      }),
      rooms: rooms.map((r) => ({ room: r.name, building: r.building || "", capacity: r.capacity ?? "", note: r.note || "" })),
      periods: periods.map((p) => ({ name: p.name, start: fmtMin(p.start), end: fmtMin(p.end) })),
    };
    if (terms.length) out.terms = terms.map((t) => ({ name: t.name, from: t.from, to: t.to }));
    return out;
  }

  const USAGE_LINES = [
    "このファイルの使い方",
    "「時間割」シートに部屋の使用予定を1行ずつ入力し、schedule.xlsx という名前のままサイトに置くと反映されます。",
    "",
    "■ 時間割シートの列",
    "部屋: 部屋名（例: 101教室、セミナー室A）。必須。",
    "曜日: 毎週の予定の曜日。「月」「月曜日」「Mon」のほか、「月・水」「月〜金」「平日」のように複数まとめて書けます。",
    "日付: その日だけの予定（臨時の予約など）は日付を入れます（例: 2026/12/01）。日付があれば曜日は空欄で構いません。",
    "開始・終了: 「9:00」「13:30」のような時刻。「2限」のように時限名で書いても構いません。",
    "内容: 授業名・利用目的など。",
    "担当者・備考: 任意。空欄で構いません。",
    "※ 「開始」「終了」の代わりに「時間」列に「9:00-10:30」や「1-2限」とまとめて書くこともできます。",
    "",
    "■ クォーター（期間）",
    "クォーターごとに時間割が変わる場合は、「2Q」「3Q」のように期間ごとのシートを作り（列は時間割シートと同じ）、「期間」シートに各シートの期間を書きます。",
    "「期間」シートの列: シート（シート名）・開始日・終了日（例: 3Q / 2026/10/01 / 2026/11/30）。サイトは表示している日付の期間のシートを自動で使います。",
    "どの期間にも入らない日は「授業期間外」と表示されます。「期間」シートに書かれていない「時間割」シートの予定は、すべての期間に共通の予定として扱われます。",
    "",
    "■ 休講・中止",
    "日付を入れて、内容を「休講」や「中止」で始めると、その日のその時間の毎週の予定が取り消されます。",
    "",
    "■ 部屋シート（任意）",
    "部屋の並び順・建物・定員・備考を書けます。サイトの絞り込みや空き部屋検索で使われます。",
    "",
    "■ 時限シート（任意）",
    "「1限 = 9:00〜10:30」のような時限の定義です。ここを書き換えると時限名での入力やボタンに反映されます。",
    "",
    "■ 注意",
    "・同じ部屋・同じ時間に予定が重なると、サイトの「データ編集」画面に警告が表示されます。",
    "・読み取れなかった行も「データ編集」画面に行番号つきで表示されます。",
  ];

  return {
    DAYS, pad2, nfkc, isBlank, fmtMin, fmtDuration,
    parseTime, parseTimeRange, parsePeriodRef, parseDays, parseDate,
    dateOnly, dayIndexOf, ymd, parseYmd, addDays, startOfWeek, sameDay, fmtDate,
    mapHeader, SCHEDULE_FIELDS, parseSchedule, parseRooms, parsePeriods, parseTermTable, parseTables, parseWorkbook,
    parseDelimited, jsonToTables, makeEntry, newId,
    applyTerms, inTerm, termsOn, termFor, termContext, termLabel, fmtYmd,
    compileRooms, isCancel, entriesOn, mergeConsecutive, roomStatus, freeIntervals, assignLanes, findConflicts, overlapsWith,
    sortEntries, toScheduleAoa, toRoomsAoa, toPeriodsAoa, toTermsAoa, toCSV, toJSON, USAGE_LINES,
  };
});
