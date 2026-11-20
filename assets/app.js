/* =========================================================
   app.js — 画面の表示と操作
   データ解析などの処理は core.js（window.KR）にあります。
========================================================= */
(function () {
  "use strict";
  const K = window.KR;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* =========================================================
     設定
  ========================================================= */
  const DEFAULTS = {
    title: "部屋使用状況ボード",
    eyebrow: "ROOM STATUS BOARD",
    dataSources: ["schedule.xlsx"],
    autoReloadMinutes: 10,
    soonMinutes: 15,
    dayStart: "08:00",
    dayEnd: "19:00",
    showWeekend: "auto",
    periods: [],
  };
  const CFG = Object.assign({}, DEFAULTS, window.APP_CONFIG || {});
  const DEFAULT_PERIODS = (CFG.periods || [])
    .map((p) => ({ name: String(p.name), start: K.parseTime(p.start), end: K.parseTime(p.end) }))
    .filter((p) => p.start !== null && p.end !== null && p.end > p.start);
  const DAY_START = K.parseTime(CFG.dayStart) ?? 480;
  const DAY_END = K.parseTime(CFG.dayEnd) ?? 1140;
  const PARAMS = new URLSearchParams(location.search);

  /* =========================================================
     保存（localStorage は使えない環境もあるので必ず try で包む）
  ========================================================= */
  const NS = "kitroom:" + location.pathname.replace(/[^/]*$/, "") + ":";
  const KEY = { draft: NS + "draft", fav: NS + "favorites", prefs: NS + "prefs", theme: "kitroom:theme" };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 無視 */ } },
  };

  /* =========================================================
     状態
  ========================================================= */
  const EDIT_PAGE = 200; // 編集画面で一度に表示する予定の数
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const today = () => K.dateOnly(new Date());
  const prefs = store.get(KEY.prefs, {});

  const S = {
    published: null,   // 公開データ（schedule.xlsx など）
    draft: null,       // このブラウザで編集中のデータ
    ds: null,          // 表示に使っているデータ（draft があれば draft）
    loadError: null,
    loading: true,
    tab: "now",
    live: true,
    date: today(),
    min: nowMin(),
    weekDate: today(),
    room: null,
    query: "",
    filter: "all",
    building: prefs.building || "",
    sort: prefs.sort || "default",
    tlMode: prefs.tlMode || "timeline",
    editMode: false,
    editSub: "entries",
    editQuery: "",
    editSort: "room",
    editLimit: EDIT_PAGE,
    selected: new Set(),
    favorites: new Set(store.get(KEY.fav, [])),
    free: null,
    undo: [],
    importCtx: null,
    formCtx: null,
    detailId: null,
    lastMinute: -1,
    kiosk: false,
  };

  /* =========================================================
     小物
  ========================================================= */
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const fm = K.fmtMin;
  // <input type="time"> は 24:00 を表せないので、入力欄では 23:59 と表示して読み取り時に戻す
  const tin = (m) => (m >= 1440 ? "23:59" : fm(m));
  const tout = (v) => { const m = K.parseTime(v); return m === 1439 ? 1440 : m; };
  const kana = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const norm = (s) => kana(K.nfkc(s).toLowerCase());
  const terms = (q) => norm(q).split(/\s+/).filter(Boolean);
  const matchAll = (hay, ts) => { const h = norm(hay); return ts.every((t) => h.includes(t)); };
  const entryHay = (e) => [e.room, e.title, e.owner, e.note, K.DAYS[e.day] + "曜", e.date || "", e.term || ""].join(" ");
  const roomHay = (r) => [r.name, r.building, r.note].join(" ");
  const roomByName = (name) => S.ds.rooms.find((r) => r.name === name);
  const roomMeta = (r) => r ? [r.building, r.capacity != null ? `定員${r.capacity}` : "", r.note].filter(Boolean).join(" · ") : "";
  const entryById = (id) => S.ds.entries.find((e) => e.id === id);
  const whenLabel = (e) => (e.date ? `${K.fmtDate(K.parseYmd(e.date), true)} のみ` : `毎週${K.DAYS[e.day]}曜日`);
  const conflictIds = () => new Set(S.ds.conflicts.flatMap(([a, b]) => [a.id, b.id]));

  /* ---------- 期間（クォーター） ---------- */
  const hasTerms = () => S.ds.terms.length > 0;
  const termByName = (name) => (name ? S.ds.terms.find((t) => t.name === name) : null);
  /** いま見ている日付（画面ごと） */
  function viewDate() {
    if (S.tab === "week") return S.weekDate;
    if (S.tab === "free" && S.free) return S.free.date;
    return S.date;
  }
  /** その日がどの期間にも入っていない時の案内文（入っていれば空） */
  function offTermText(date) {
    if (!hasTerms()) return "";
    const c = K.termContext(S.ds.terms, date);
    if (c.current) return "";
    const tail = c.next ? `（${c.next.name} は ${K.fmtYmd(c.next.from)} から）`
      : c.prev ? `（${c.prev.name} は ${K.fmtYmd(c.prev.to)} で終わりました）` : "";
    return `${K.fmtDate(date)} は授業期間外です${tail}`;
  }
  /** 日付バーの下に「授業期間外」の案内を出す（いまの状況・タイムライン） */
  function renderTermNote(panelSel, date) {
    const panel = $(panelSel);
    const text = offTermText(date);
    let el = $(".term-note", panel);
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.className = "term-note";
      el.setAttribute("role", "status");
      $(".datebar-slot", panel).after(el);
    }
    el.textContent = text;
  }

  function withFocus(fn) {
    const a = document.activeElement;
    const key = a && a.dataset ? a.dataset.fk : null;
    let sel = null;
    if (key) { try { sel = [a.selectionStart, a.selectionEnd]; } catch (e) { sel = null; } }
    fn();
    if (key) {
      const el = document.querySelector(`[data-fk="${CSS.escape(key)}"]`);
      if (el && el !== document.activeElement) {
        el.focus({ preventScroll: true });
        if (sel && sel[0] !== null && el.setSelectionRange) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* 対象外の入力欄 */ } }
      }
    }
  }

  function savePrefs() { store.set(KEY.prefs, { building: S.building, sort: S.sort, tlMode: S.tlMode }); }

  function toast(msg, opt = {}) {
    const box = $("#toasts");
    const el = document.createElement("div");
    el.className = "toast" + (opt.error ? " error" : "");
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (opt.action) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt.action;
      b.addEventListener("click", () => { el.remove(); opt.onAction(); });
      el.appendChild(b);
    }
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), opt.ms || (opt.action ? 7000 : 3500));
  }

  function download(content, filename, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* =========================================================
     データ読み込み
  ========================================================= */
  // 公開データは config.js の時限で解析する（このブラウザの編集中データに影響されないように）。
  // 手動の取り込みだけ、いま表示中のデータの時限を使う。
  const parseOpts = (forImport) => ({ defaultPeriods: forImport && S.ds ? S.ds.periods : DEFAULT_PERIODS });

  function decodeText(buf) {
    const u8 = new Uint8Array(buf);
    let t = new TextDecoder("utf-8").decode(u8);
    if (t.includes("�")) { try { t = new TextDecoder("shift_jis").decode(u8); } catch (e) { /* UTF-8 のまま */ } }
    return t;
  }

  function parseBinary(buf, forImport) {
    if (!window.XLSX) throw new Error("Excel 読み込み用のライブラリを読み込めませんでした（インターネット接続を確認してください）。CSV なら読み込めます");
    const wb = XLSX.read(buf, { type: "array" });
    return K.parseWorkbook(wb, XLSX, parseOpts(forImport));
  }

  const FALLBACK_HEADER = ["部屋", "曜日", "開始", "終了", "内容", "担当者", "備考"];

  /** CSV / TSV / JSON の文字列を解析。見出し行がなければ標準の列順とみなす */
  function parseText(text, forImport) {
    // 先頭の空セル（タブ）を消さないよう、前後の trim はしない
    const s = String(text || "").replace(/^﻿/, "").replace(/[\r\n]+$/, "");
    if (!s.trim()) throw new Error("データが空です");
    if (/^\s*[\[{]/.test(s)) {
      let obj;
      try { obj = JSON.parse(s); } catch (e) { throw new Error("JSON として読み取れません: " + e.message); }
      return K.parseTables(K.jsonToTables(obj), parseOpts(forImport));
    }
    const aoa = K.parseDelimited(s);
    try {
      return K.parseTables({ schedule: { aoa, offset: 0, name: "" } }, parseOpts(forImport));
    } catch (err) {
      const first = aoa.find((r) => r.some((c) => String(c).trim()));
      if (!first || first.length < 3) throw err;
      const res = K.parseTables({ schedule: { aoa: [FALLBACK_HEADER, ...aoa], offset: -1, name: "" } }, parseOpts(forImport));
      res.issues.unshift({ level: "warn", msg: "見出し行がないため、列を「部屋・曜日・開始・終了・内容・担当者・備考」の順とみなしました" });
      return res;
    }
  }

  async function parseFile(file) {
    const name = file.name.toLowerCase();
    const buf = await file.arrayBuffer();
    if (/\.(csv|tsv|txt|json)$/.test(name)) return parseText(decodeText(buf), true);
    return parseBinary(buf, true);
  }

  function googleSheetId(src) {
    const m = /docs\.google\.com\/spreadsheets\/d\/([\w-]+)/.exec(src);
    return m && m[1] !== "e" ? m[1] : null;
  }

  async function fetchOk(url) {
    let res;
    try { res = await fetch(url, { cache: "no-store" }); }
    catch (e) {
      throw new Error(location.protocol === "file:" ? "ファイルを直接開いているため自動では読み込めません"
        : "読み込めませんでした（ネットワークの問題か、別のサイトにあるファイルで読み込みが許可されていない可能性があります）");
    }
    if (!res.ok) throw new Error(res.status === 404 ? "ファイルが見つかりません" : `読み込みに失敗しました（HTTP ${res.status}）`);
    return res;
  }

  async function loadGoogleSheet(id) {
    // headers=1: 見出しは1行目だけとして扱わせる（指定しないと複数行が見出しにまとめられることがある）
    const url = (sheet) => `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(sheet)}`;
    const get = async (sheet) => {
      try { return K.parseDelimited(await (await fetchOk(url(sheet))).text()); }
      catch (e) { throw new Error("Googleスプレッドシートを読み込めません。共有設定を「リンクを知っている全員（閲覧者）」にしてください"); }
    };
    const schedule = await get("時間割");
    const [rooms, periods] = await Promise.all([get("部屋").catch(() => null), get("時限").catch(() => null)]);
    return K.parseTables({
      schedule: { aoa: schedule, offset: 0, name: "時間割" },
      rooms: rooms && { aoa: rooms, offset: 0, name: "部屋" },
      periods: periods && { aoa: periods, offset: 0, name: "時限" },
    }, { defaultPeriods: DEFAULT_PERIODS });
  }

  async function loadSource(src) {
    const gid = googleSheetId(src);
    if (gid) return loadGoogleSheet(gid);
    const res = await fetchOk(src);
    const path = src.toLowerCase().split(/[?#]/)[0];
    if (/\.(csv|tsv|txt|json)$/.test(path) || /output=csv|format=csv|tqx=out:csv/.test(src)) return parseText(decodeText(await res.arrayBuffer()));
    return parseBinary(await res.arrayBuffer());
  }

  function signature(raw) {
    // 期間のないデータでは以前と同じ値になるよう、期間があるときだけ含める
    const parts = [raw.entries.map((e) => [e.room, e.day, e.date, e.start, e.end, e.title, e.owner, e.note, ...(e.term ? [e.term] : [])]), raw.rooms, raw.periods];
    if (raw.terms && raw.terms.length) parts.push(raw.terms);
    const s = JSON.stringify(parts);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  async function reload(silent) {
    const srcs = PARAMS.get("src") ? [PARAMS.get("src")] : [].concat(CFG.dataSources || []);
    const errors = [];
    let loaded = null;
    for (const src of srcs) {
      try { loaded = { raw: await loadSource(src), src }; break; }
      catch (e) { errors.push(`${src}: ${e.message}`); console.warn(e); }
    }
    S.loading = false;
    if (loaded) {
      const sig = signature(loaded.raw);
      const hadData = !!S.published;
      const changed = !hadData || S.published.sig !== sig || !!S.loadError;
      S.published = { ...loaded.raw, sig, src: loaded.src, loadedAt: new Date() };
      S.loadError = null;
      if (silent && hadData && changed && !S.draft) toast("時間割データが更新されました");
      if (silent && !changed) { renderNotices(); return; }
    } else {
      S.loadError = errors.join(" / ") || "データの読み込み先が設定されていません（config.js の dataSources）";
    }
    refreshDataset();
    renderAll();
  }

  /* =========================================================
     表示用データ
  ========================================================= */
  /* 部屋名から建物を決めるルール（config.js の buildingRules） */
  const BUILDING_RULES = (CFG.buildingRules || []).map((r) => {
    try { return { re: new RegExp(r.match), name: String(r.name) }; } catch (e) { console.warn("buildingRules の書き方が正しくありません:", r); return null; }
  }).filter(Boolean);
  const OTHER_BUILDING = CFG.otherBuilding ?? "";
  const BUILDING_ORDER = [...BUILDING_RULES.map((r) => r.name), OTHER_BUILDING];
  function autoBuilding(name) {
    if (!BUILDING_RULES.length) return "";
    const hit = BUILDING_RULES.find((r) => r.re.test(name));
    return hit ? hit.name : OTHER_BUILDING;
  }

  function makeDataset(raw, isDraft) {
    const entries = raw.entries || [];
    let rooms = K.compileRooms(raw.rooms || [], entries).map((r) => (r.building ? r : { ...r, building: autoBuilding(r.name) }));
    // 「部屋」シートで並び順が決まっていない時は、建物ごと・番号順に並べる（講義棟 → 研究棟 → その他）
    if (!isDraft && !(raw.rooms && raw.rooms.length)) {
      const bi = (b) => { const i = BUILDING_ORDER.indexOf(b); return i < 0 ? 99 : i; };
      rooms = rooms.sort((a, b) => bi(a.building) - bi(b.building) || a.name.localeCompare(b.name, "ja", { numeric: true }));
    }
    // 編集中のデータは時限を全部消した状態も尊重する。公開データは時限シートがなければ config.js の定義
    const periods = isDraft ? raw.periods || [] : raw.periods && raw.periods.length ? raw.periods : DEFAULT_PERIODS;
    // 期間（クォーター）の日付は期間の一覧から付け直す（一覧にない期間名の予定はいつでも表示）
    const terms = raw.terms || [];
    K.applyTerms(entries, terms);
    return {
      entries,
      rooms,
      periods,
      terms,
      issues: raw.issues || [],
      conflicts: K.findConflicts(entries),
      hasWeekend: entries.some((e) => e.day >= 5),
      buildings: [...new Set(rooms.map((r) => r.building).filter(Boolean))],
      hasCapacity: rooms.some((r) => r.capacity != null),
    };
  }

  function refreshDataset() {
    S.ds = makeDataset(S.draft || S.published || { entries: [], rooms: [], periods: [], terms: [] }, !!S.draft);
    mergedView.clear();
    if (S.free && S.free.anchor != null && !S.ds.periods[S.free.anchor]) S.free.anchor = null;
    if (S.formCtx && S.formCtx.anchor != null && !S.ds.periods[S.formCtx.anchor]) S.formCtx.anchor = null;
    if (!S.room || !roomByName(S.room)) S.room = (S.ds.rooms.find((r) => S.favorites.has(r.name)) || S.ds.rooms[0] || {}).name || null;
    if (S.building && !S.ds.buildings.includes(S.building)) S.building = "";
    const ids = new Set(S.ds.entries.map((e) => e.id));
    S.selected.forEach((id) => { if (!ids.has(id)) S.selected.delete(id); });
  }

  /**
   * その日の予定（連続するコマはまとめた形）。まとめた予定は詳細表示のために覚えておく。
   */
  const mergedView = new Map();
  function dayEntries(date, opt = {}) {
    const list = K.entriesOn(S.ds.entries, date, opt);
    list.forEach((e) => { if (e.partIds && e.partIds.length > 1) mergedView.set(e.id, e); });
    return list;
  }

  /** 開始〜終了に含まれる時限の名前（例: 「3・4限」）。時限とずれていれば空 */
  function periodLabel(start, end) {
    const ps = S.ds.periods.filter((p) => p.start >= start && p.end <= end);
    if (!ps.length || ps[0].start !== start || ps[ps.length - 1].end !== end) return "";
    const nums = ps.map((p) => (/^\d+限$/.test(p.name) ? p.name.replace("限", "") : p.name));
    return nums.every((n) => /^\d+$/.test(n)) ? nums.join("・") + "限" : ps.map((p) => p.name).join("・");
  }

  /** 検索語・建物で絞り込んだ部屋（お気に入りは上） */
  function visibleRooms(opt = {}) {
    const ts = terms(S.query);
    let rooms = S.ds.rooms.filter((r) => {
      if (S.building && r.building !== S.building) return false;
      if (!ts.length) return true;
      if (matchAll(roomHay(r), ts)) return true;
      return S.ds.entries.some((e) => e.room === r.name && matchAll(entryHay(e), ts));
    });
    if (opt.favFirst !== false) {
      rooms = [...rooms.filter((r) => S.favorites.has(r.name)), ...rooms.filter((r) => !S.favorites.has(r.name))];
    }
    return rooms;
  }

  const entryHit = (e) => { const ts = terms(S.query); return ts.length > 0 && matchAll(entryHay(e), ts); };

  function showWeekend() {
    if (CFG.showWeekend === true) return true;
    if (CFG.showWeekend === false) return false;
    return S.ds.hasWeekend;
  }

  function timeRange(list) {
    let t0 = Math.floor(DAY_START / 60) * 60;
    let t1 = Math.ceil(DAY_END / 60) * 60;
    list.forEach((e) => { t0 = Math.min(t0, Math.floor(e.start / 60) * 60); t1 = Math.max(t1, Math.ceil(e.end / 60) * 60); });
    return [t0, Math.max(t1, t0 + 60)];
  }

  /* =========================================================
     描画: 全体
  ========================================================= */
  function renderAll() {
    document.body.dataset.tab = S.tab;
    document.body.classList.toggle("editing", S.editMode);
    $$(".tab-btn").forEach((b) => {
      const on = b.dataset.tab === S.tab;
      b.setAttribute("aria-selected", on);
      b.setAttribute("tabindex", "0");
    });
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + S.tab));
    const issueCount = S.ds.conflicts.length + (S.draft ? 0 : S.ds.issues.filter((i) => i.level === "error").length);
    const editTab = $('.tab-btn[data-tab="edit"]');
    $(".badge-slot", editTab).innerHTML = issueCount ? `<span class="badge" title="確認が必要な項目">${issueCount}</span>` : "";
    $("#footerSource").textContent = S.draft ? "データ: このブラウザで編集中のデータ" : `データ出典: ${S.published ? S.published.src : (CFG.dataSources || [])[0] || "-"}`;
    renderNotices();
    renderSearchResults();
    renderTab();
  }

  function renderTab() {
    const fn = { now: renderNow, timeline: renderTimeline, week: renderWeek, free: renderFree, edit: renderEdit }[S.tab];
    withFocus(fn);
    // 表示している日付が変わると期間（クォーター）の表示も変わる
    if (hasTerms()) renderNotices();
  }

  /** お知らせ欄の先頭に出す、表示中の日付の期間（例: 3Q（10/1〜11/30）） */
  function termPrefix() {
    if (!hasTerms()) return "";
    const c = K.termContext(S.ds.terms, viewDate());
    if (c.current) return K.termLabel(c.current);
    return c.next ? `授業期間外（次は ${K.termLabel(c.next)}）` : "授業期間外";
  }

  let lastNotices = null;
  function renderNotices() {
    const out = [];
    if (S.loading) out.push(`<div class="notice info">データを読み込み中です…</div>`);
    if (S.loadError && S.draft) {
      // 取り込んだデータで表示できているので、控えめに知らせるだけにする
      out.push(`<div class="notice info"><span>公開データは読み込めていません（${esc(S.loadError)}）</span></div>`);
    } else if (S.loadError) {
      out.push(`<div class="notice error"><span class="grow"><b>データを読み込めませんでした。</b> ${esc(S.loadError)}${location.protocol === "file:" ? "<br>schedule.xlsx をこの画面にドラッグ＆ドロップすると表示できます。" : ""}</span>
        <button class="btn" type="button" data-act="import-file">ファイルを選ぶ</button>
        ${location.protocol === "file:" ? "" : `<button class="btn" type="button" data-act="reload">再読み込み</button>`}</div>`);
    }
    if (S.draft && S.tab !== "edit") {
      const stale = S.published && S.draft.baseSig && S.draft.baseSig !== S.published.sig;
      out.push(`<div class="notice draft"><span class="grow"><b>✎ このブラウザで編集中のデータを表示しています。</b> まだ他の人には見えません。${stale ? "<br>※ 編集を始めた後に公開データが更新されています。" : ""}</span>
        <button class="btn" type="button" data-act="export-xlsx">Excel に書き出す</button>
        <button class="btn" type="button" data-act="discard-draft">編集をやめて公開データに戻す</button></div>`);
    }
    const tp = termPrefix();
    if (S.published && !S.draft) {
      const errs = S.ds.issues.filter((i) => i.level === "error").length;
      const t = S.published.loadedAt;
      out.push(`<div class="notice info"><span>${tp ? `<b class="term-now">${esc(tp)}</b> · ` : ""}${S.ds.entries.length}件の予定 / ${S.ds.rooms.length}部屋 · ${esc(S.published.src)} · ${K.pad2(t.getHours())}:${K.pad2(t.getMinutes())} 読み込み</span>
        ${errs ? `<button class="btn small danger" type="button" data-act="goto-issues">読み取れない行が ${errs} 件あります</button>` : ""}</div>`);
    } else if (tp) {
      out.push(`<div class="notice info"><span><b class="term-now">${esc(tp)}</b> · ${S.ds.entries.length}件の予定 / ${S.ds.rooms.length}部屋</span></div>`);
    }
    const html = out.join("");
    // 毎分の再描画でボタンのフォーカスが外れないよう、内容が変わった時だけ書き換える
    if (html !== lastNotices) { $("#notices").innerHTML = html; lastNotices = html; }
  }

  function renderSearchResults() {
    const box = $("#searchResults");
    const ts = terms(S.query);
    if (!ts.length || S.tab === "edit") { box.innerHTML = ""; return; }
    const hits = K.sortEntries(S.ds.entries.filter((e) => matchAll(entryHay(e), ts)), S.ds.rooms.map((r) => r.name));
    const rooms = S.ds.rooms.filter((r) => matchAll(roomHay(r), ts));
    if (!hits.length && !rooms.length) {
      box.innerHTML = `<div class="search-results">「${esc(S.query)}」に一致する部屋・予定はありません。 <button class="btn small" type="button" data-act="clear-q">検索をクリア</button></div>`;
      return;
    }
    box.innerHTML = `<details class="search-results" ${hits.length <= 8 ? "open" : ""}>
      <summary>「${esc(S.query)}」の検索結果: 部屋 ${rooms.length}件 · 予定 ${hits.length}件（下の表示も絞り込まれています）</summary>
      <ul>${hits.slice(0, 100).map((e) => `<li><button type="button" data-act="entry" data-id="${esc(e.id)}">
        <span>${esc(e.room)}</span><span class="sr-time">${e.term && hasTerms() ? `<span class="term-tag">${esc(e.term)}</span>` : ""}${e.date ? esc(e.date.slice(5).replace("-", "/")) : K.DAYS[e.day] + "曜"} ${fm(e.start)}–${fm(e.end)}</span>
        <span><b>${esc(e.title || "（内容未設定）")}</b> <span class="muted">${esc(e.owner)}</span></span></button></li>`).join("")}</ul>
    </details>`;
  }

  /* ---------- 日付バー（いまの状況・タイムライン共通） ---------- */
  function renderDatebar(slot) {
    const ws = K.startOfWeek(S.date);
    const td = today();
    if (!slot.firstElementChild) {
      slot.innerHTML = `<div class="datebar">
        <div class="live-state"><span class="live-dot"></span><span class="live-text"></span></div>
        <div class="day-strip" role="group" aria-label="曜日を選ぶ"></div>
        <div class="date-nav">
          <button class="btn compact-icon" type="button" data-act="shift-day" data-n="-7" title="前の週" aria-label="前の週">«</button>
          <button class="btn compact-icon" type="button" data-act="shift-day" data-n="-1" title="前の日（←）" aria-label="前の日">‹</button>
          <input type="date" data-bind="date" aria-label="日付">
          <button class="btn compact-icon" type="button" data-act="shift-day" data-n="1" title="次の日（→）" aria-label="次の日">›</button>
          <button class="btn compact-icon" type="button" data-act="shift-day" data-n="7" title="次の週" aria-label="次の週">»</button>
        </div>
        <label>時刻 <input type="time" data-bind="time" step="60"></label>
        <div class="dp-chips" role="group" aria-label="時限で指定"></div>
        <button class="btn" type="button" data-act="now">現在に戻す</button>
      </div>`;
    }
    $(".live-dot", slot).classList.toggle("paused", !S.live);
    $(".live-text", slot).textContent = S.live ? "現在の状況を表示中" : `${K.fmtDate(S.date)} ${fm(S.min)} の状況を表示中`;
    $(".day-strip", slot).innerHTML = K.DAYS.map((d, i) => {
      const dt = K.addDays(ws, i);
      const on = K.sameDay(dt, S.date);
      return `<button type="button" class="day-btn${i === 5 ? " sat" : ""}${i === 6 ? " sun" : ""}${on ? " active" : ""}${K.sameDay(dt, td) ? " today" : ""}"
        data-act="set-date" data-date="${K.ymd(dt)}" data-fk="${slot.closest(".panel").id}-day-${i}" aria-pressed="${on}"
        title="${K.fmtDate(dt, true)}${K.sameDay(dt, td) ? "（今日）" : ""}">${d}<small>${dt.getMonth() + 1}/${dt.getDate()}</small></button>`;
    }).join("");
    const di = $('[data-bind="date"]', slot);
    const ti = $('[data-bind="time"]', slot);
    if (document.activeElement !== di) di.value = K.ymd(S.date);
    if (document.activeElement !== ti) ti.value = fm(S.min);
    const nb = $('[data-act="now"]', slot);
    nb.disabled = S.live;
    nb.classList.toggle("primary", !S.live);
    // 時限ボタン（押すとその時限の開始時刻の状況になる）
    $(".dp-chips", slot).innerHTML = S.ds.periods.map((p, i) => {
      const on = p.start <= S.min && S.min < p.end;
      return `<button type="button" class="period-chip${on ? " on" : ""}" data-act="set-period" data-i="${i}" aria-pressed="${on}" data-fk="${slot.closest(".panel").id}-p-${i}" title="${esc(p.name)} ${fm(p.start)}–${fm(p.end)}">${esc(p.name)}</button>`;
    }).join("");
  }

  /* =========================================================
     描画: いまの状況
  ========================================================= */
  function stripHTML(list, t0, t1, mark) {
    const span = t1 - t0;
    return `<div class="mini-strip" aria-hidden="true">${list.map((e) =>
      `<span class="blk${e.cancelled ? " cancelled" : ""}" style="left:${((e.start - t0) / span) * 100}%;width:${((e.end - e.start) / span) * 100}%" title="${fm(e.start)}–${fm(e.end)} ${esc(e.title)}"></span>`).join("")}
      ${mark >= t0 && mark <= t1 ? `<span class="now" style="left:calc(${((mark - t0) / span) * 100}% - 1px)"></span>` : ""}</div>`;
  }

  function renderNow() {
    renderDatebar($("#panel-now .datebar-slot"));
    renderTermNote("#panel-now", S.date);
    const list = dayEntries(S.date, { withCancelled: true });
    const [t0, t1] = timeRange(list);
    let rows = visibleRooms().map((r) => ({ r, st: K.roomStatus(list, r.name, S.min, CFG.soonMinutes) }));
    const count = { all: rows.length, busy: 0, soon: 0, free: 0 };
    rows.forEach((x) => count[x.st.state]++);

    if (S.filter === "free") rows = rows.filter((x) => x.st.state !== "busy");
    else if (S.filter === "busy") rows = rows.filter((x) => x.st.state === "busy");
    const fav = (x) => (S.favorites.has(x.r.name) ? 0 : 1);
    if (S.sort === "name") rows.sort((a, b) => fav(a) - fav(b) || a.r.name.localeCompare(b.r.name, "ja", { numeric: true }));
    else if (S.sort === "free") {
      const rank = { free: 0, soon: 1, busy: 2 };
      rows.sort((a, b) => fav(a) - fav(b) || rank[a.st.state] - rank[b.st.state] ||
        (b.st.freeUntil ?? 9999) - (a.st.freeUntil ?? 9999) || (a.st.busyUntil ?? 0) - (b.st.busyUntil ?? 0));
    }

    const seg = (v, label, dot) => `<button type="button" data-act="filter" data-v="${v}" aria-pressed="${S.filter === v}">${dot ? `<span class="dot ${dot}"></span>` : ""}${label}<span class="count">${v === "free" ? count.free + count.soon : count[v]}</span></button>`;
    $("#nowSummary").innerHTML = `<div class="summary">
      <div class="seg-filter" role="group" aria-label="状態で絞り込み">${seg("all", "すべて")}${seg("free", "空き", "free")}${seg("busy", "使用中", "busy")}</div>
      ${count.soon ? `<span class="muted" style="font-size:12px"><span class="dot soon"></span> まもなく使用 ${count.soon}</span>` : ""}
      <span class="spacer"></span>
      ${buildingSelect()}
      <select data-bind="sort" aria-label="並び順">
        <option value="default" ${S.sort === "default" ? "selected" : ""}>標準の順</option>
        <option value="name" ${S.sort === "name" ? "selected" : ""}>名前順</option>
        <option value="free" ${S.sort === "free" ? "selected" : ""}>空いている順</option>
      </select>
    </div>`;

    const cids = conflictIds();
    const boardEl = $("#boardList");
    if (!S.ds.rooms.length) { boardEl.innerHTML = emptyData(); return; }
    if (!rows.length) {
      boardEl.innerHTML = `<div class="empty-state">${S.query && !count.all ? `「${esc(S.query)}」に一致する部屋はありません。` : "条件に合う部屋はありません。"}</div>`;
      return;
    }
    boardEl.innerHTML = rows.map(({ r, st }) => {
      const isFav = S.favorites.has(r.name);
      const mine = list.filter((e) => e.room === r.name);
      let detail = "";
      if (st.state === "busy") {
        const c = st.current[0];
        const left = c.end - S.min;
        const pct = Math.min(100, Math.max(0, ((S.min - c.start) / (c.end - c.start)) * 100));
        detail = `<div class="now-line">${st.current.map((e) => `<button type="button" class="title" data-act="entry" data-id="${esc(e.id)}">${esc(e.title || "（内容未設定）")}</button>${e.owner ? `<span class="owner">${esc(e.owner)}</span>` : ""}`).join(" ")}
            ${st.current.length > 1 || cids.has(c.id) ? `<span class="conflict-mark" title="同じ時間に複数の予定があります">⚠ 重複</span>` : ""}</div>
          <div class="sub-line mono">${fm(c.start)}–${fm(c.end)} · 残り <b>${K.fmtDuration(left)}</b>${st.busyUntil > c.end ? ` · ${fm(st.busyUntil)} まで連続で使用` : ""}${st.next ? ` · 次 ${fm(st.next.start)} ${esc(st.next.title)}` : ""}</div>
          <div class="progress" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="経過"><span style="width:${pct}%"></span></div>`;
      } else if (st.state === "soon") {
        detail = `<div class="now-line"><span class="empty">いまは空いています</span></div>
          <div class="sub-line mono"><b>${K.fmtDuration(st.next.start - S.min)}後</b>に使用開始 · ${fm(st.next.start)}– <button type="button" class="title" data-act="entry" data-id="${esc(st.next.id)}">${esc(st.next.title || "（内容未設定）")}</button></div>`;
      } else {
        detail = st.next
          ? `<div class="now-line"><span class="empty">空き</span></div>
             <div class="sub-line mono"><b>${fm(st.next.start)}</b> まで空いています（あと${K.fmtDuration(st.next.start - S.min)}）· 次 <button type="button" class="title" data-act="entry" data-id="${esc(st.next.id)}">${esc(st.next.title || "（内容未設定）")}</button></div>`
          : `<div class="now-line"><span class="empty">空き</span></div>
             <div class="sub-line">${mine.some((e) => !e.cancelled) ? "この後の予定はありません" : "この日の予定はありません"}</div>`;
      }
      const label = { busy: "使用中", soon: "まもなく", free: "空き" }[st.state];
      return `<div class="board-row" data-room="${esc(r.name)}">
        <button type="button" class="fav${isFav ? " on" : ""}" data-act="fav" data-room="${esc(r.name)}" aria-pressed="${isFav}" title="${isFav ? "お気に入りから外す" : "お気に入りに追加（上に表示）"}" aria-label="お気に入り">${isFav ? "★" : "☆"}</button>
        <div class="room-name"><button type="button" class="room-link" data-act="goto-room" data-room="${esc(r.name)}" title="この部屋の時間割を見る">${esc(r.name)}</button>${roomMeta(r) ? `<span class="room-meta">${esc(roomMeta(r))}</span>` : ""}</div>
        <div class="room-detail">${detail}${stripHTML(mine, t0, t1, S.min)}</div>
        <div class="status-pill status-${st.state}">${label}</div>
      </div>`;
    }).join("");
  }

  function buildingSelect() {
    if (!S.ds.buildings.length) return "";
    return `<select data-bind="building" aria-label="建物で絞り込み"><option value="">すべての建物</option>${S.ds.buildings.map((b) =>
      `<option value="${esc(b)}" ${S.building === b ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>`;
  }

  function emptyData() {
    if (S.loading) return `<div class="empty-state">読み込み中…</div>`;
    return `<div class="empty-state">表示できる部屋がありません。<br>schedule.xlsx を用意するか、データを取り込んでください。<br>
      <button class="btn" type="button" data-act="import-file">ファイルから取り込む</button>
      <button class="btn" type="button" data-act="add-entry">予定を追加する</button></div>`;
  }

  /* =========================================================
     描画: タイムライン
  ========================================================= */
  function blockHTML(e, style, cids, extra = "") {
    const cls = ["blk-entry", e.date ? "dated" : "", e.cancelled ? "cancelled" : "", cids.has(e.id) ? "conflict" : "", terms(S.query).length ? (entryHit(e) ? "hit" : "") : "", extra].filter(Boolean).join(" ");
    const tip = `${fm(e.start)}–${fm(e.end)} ${e.title || ""}${e.owner ? " / " + e.owner : ""}${e.cancelled ? "（休講）" : ""}`;
    return `<button type="button" class="${cls}" style="${style}" data-act="entry" data-id="${esc(e.id)}" title="${esc(tip)}">
      <span class="b-title">${e.cancelled ? "休講 " : ""}${esc(e.title || "（内容未設定）")}</span>
      <span class="b-sub">${fm(e.start)}–${fm(e.end)}${e.owner ? " " + esc(e.owner) : ""}</span></button>`;
  }

  function tlModeSwitch() {
    return `<div class="seg-filter" role="group" aria-label="表示形式">
      <button type="button" data-act="tl-mode" data-v="timeline" aria-pressed="${S.tlMode !== "matrix"}">タイムライン</button>
      <button type="button" data-act="tl-mode" data-v="matrix" aria-pressed="${S.tlMode === "matrix"}" ${S.ds.periods.length ? "" : "disabled"}>時限の表</button>
    </div>`;
  }

  /** 全部屋 × 時限の表 */
  function renderMatrix(el) {
    const list = dayEntries(S.date, { withCancelled: true, merge: false });
    const rooms = visibleRooms();
    const ps = S.ds.periods;
    const cids = conflictIds();
    const curIdx = ps.findIndex((p) => p.start <= S.min && S.min < p.end);
    const head = `<tr><th class="mx-room">${K.fmtDate(S.date, true)}</th>${ps.map((p, i) =>
      `<th class="${i === curIdx ? "cur" : ""}">${esc(p.name)}<small>${fm(p.start)}–${fm(p.end)}</small></th>`).join("")}</tr>`;
    const body = rooms.map((r) => {
      const mine = list.filter((e) => e.room === r.name);
      return `<tr><th class="mx-room"><button type="button" class="room-link" data-act="goto-room" data-room="${esc(r.name)}">${S.favorites.has(r.name) ? "★ " : ""}${esc(r.name)}</button>${r.building ? `<span class="room-meta">${esc(r.building)}</span>` : ""}</th>
        ${ps.map((p, i) => {
          const hits = mine.filter((e) => e.start < p.end && p.start < e.end);
          if (!hits.length) return `<td class="mx-free${i === curIdx ? " cur" : ""}" data-act="slot-period" data-room="${esc(r.name)}" data-i="${i}"><span class="sr">空き</span></td>`;
          return `<td class="mx-busy${i === curIdx ? " cur" : ""}">${hits.map((e) =>
            `<button type="button" class="mx-entry${e.cancelled ? " cancelled" : ""}${e.date ? " dated" : ""}${cids.has(e.id) ? " conflict" : ""}${terms(S.query).length && entryHit(e) ? " hit" : ""}" data-act="entry" data-id="${esc(e.id)}" title="${esc(`${fm(e.start)}–${fm(e.end)} ${e.title} ${e.owner}`)}">
              <span class="b-title">${e.cancelled ? "休講 " : ""}${esc(e.title || "（内容未設定）")}</span>${e.owner ? `<span class="b-sub">${esc(e.owner)}</span>` : ""}</button>`).join("")}</td>`;
        }).join("")}</tr>`;
    }).join("");
    el.innerHTML = `<div class="tl-legend">${tlModeSwitch()}
        <span><span class="dot busy"></span>使用</span><span><span class="dot free"></span>空き</span>${curIdx >= 0 ? `<span>枠で囲んだ列が${S.live ? "現在" : "指定時刻"}の時限</span>` : ""}
        <span class="spacer"></span>${buildingSelect()}</div>
      ${rooms.length ? `<div class="tl-scroll"><table class="matrix"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
        : `<div class="empty-state">「${esc(S.query)}」に一致する部屋はありません。</div>`}`;
  }

  function renderTimeline() {
    renderDatebar($("#panel-timeline .datebar-slot"));
    renderTermNote("#panel-timeline", S.date);
    if (S.tlMode === "matrix" && S.ds.periods.length && S.ds.rooms.length) { renderMatrix($("#timeline")); return; }
    const list = dayEntries(S.date, { withCancelled: true });
    const [t0, t1] = timeRange(list);
    const span = t1 - t0;
    const hours = span / 60;
    const rooms = visibleRooms();
    const cids = conflictIds();
    const el = $("#timeline");
    if (!S.ds.rooms.length) { el.innerHTML = emptyData(); return; }

    const scale = [];
    for (let m = t0 + 60; m < t1; m += 60) scale.push(`<span style="left:${((m - t0) / span) * 100}%">${m / 60}:00</span>`);
    const showNow = S.min >= t0 && S.min <= t1;
    const nowLine = showNow ? `<div class="tl-now" style="left:${((S.min - t0) / span) * 100}%" title="${fm(S.min)}"></div>` : "";
    const grid = `background-image:linear-gradient(to right, var(--line) 1px, transparent 1px);background-size:calc(100% / ${hours}) 100%`;

    const rowsHTML = rooms.map((r) => {
      const mine = list.filter((e) => e.room === r.name);
      const lanes = K.assignLanes(mine);
      const blocks = mine.map((e) => {
        const { lane, lanes: n } = lanes.get(e);
        const style = `left:${((e.start - t0) / span) * 100}%;width:calc(${((e.end - e.start) / span) * 100}% - 2px);top:${4 + (lane * 46) / n}px;height:${46 / n - 2}px`;
        return blockHTML(e, style, cids);
      }).join("");
      return `<div class="tl-row">
        <div class="tl-room"><button type="button" class="room-link" data-act="goto-room" data-room="${esc(r.name)}" title="${esc(r.name)}">${S.favorites.has(r.name) ? "★ " : ""}${esc(r.name)}</button>${roomMeta(r) ? `<span class="room-meta">${esc(roomMeta(r))}</span>` : ""}</div>
        <div class="tl-track" data-act="slot" data-room="${esc(r.name)}" data-t0="${t0}" data-t1="${t1}" style="${grid}">${blocks}${nowLine}</div>
      </div>`;
    }).join("");

    el.innerHTML = `<div class="tl-legend">${tlModeSwitch()}
        <span><span class="dot busy"></span>毎週の予定</span><span><span class="dot soon"></span>この日だけの予定</span>
        <span>▨ 休講</span>${S.editMode ? `<span>✎ 空いている所をクリックすると予定を追加できます</span>` : ""}
        <span class="spacer"></span>${buildingSelect()}
      </div>
      ${rooms.length ? `<div class="tl-scroll"><div class="tl">
        <div class="tl-row tl-head"><div class="tl-room">${K.fmtDate(S.date, true)}</div><div class="tl-scale">${scale.join("")}</div></div>
        ${rowsHTML}</div></div>` : `<div class="empty-state">「${esc(S.query)}」に一致する部屋はありません。</div>`}`;
  }

  /* =========================================================
     描画: 部屋の時間割（週）
  ========================================================= */
  function renderWeek() {
    const rooms = visibleRooms();
    const picker = $("#roomPicker");
    const view = $("#weekView");
    if (!S.ds.rooms.length) { picker.innerHTML = ""; view.innerHTML = emptyData(); return; }
    if (rooms.length && !rooms.some((r) => r.name === S.room)) S.room = rooms[0].name;

    // 部屋が多い時はボタンを並べず、お気に入りのボタン＋プルダウンにする（スマホで時間割が遠くならないように）
    const many = rooms.length > 12;
    const chipRooms = many ? rooms.filter((r) => S.favorites.has(r.name) || r.name === S.room) : rooms;
    picker.innerHTML = `<div class="room-picker">
      ${many ? `<select class="room-select" data-bind="room-select" aria-label="部屋を選ぶ" data-fk="room-select">${rooms.map((r) =>
        `<option value="${esc(r.name)}" ${r.name === S.room ? "selected" : ""}>${S.favorites.has(r.name) ? "★ " : ""}${esc(r.name)}${r.building ? `（${esc(r.building)}）` : ""}</option>`).join("")}</select>` : ""}
      <div class="room-chips" role="group" aria-label="${many ? "お気に入りの部屋" : "部屋を選ぶ"}">${chipRooms.map((r) =>
        `<button type="button" class="room-chip${r.name === S.room ? " active" : ""}" data-act="pick-room" data-room="${esc(r.name)}" aria-pressed="${r.name === S.room}" data-fk="chip-${esc(r.name)}">${S.favorites.has(r.name) ? '<span class="star">★</span>' : ""}${esc(r.name)}</button>`).join("") ||
        (rooms.length ? "" : `<span class="muted">「${esc(S.query)}」に一致する部屋はありません。</span>`)}</div>
    </div>`;

    const room = roomByName(S.room);
    if (!room) { view.innerHTML = ""; return; }
    const ws = K.startOfWeek(S.weekDate);
    const nDays = showWeekend() ? 7 : 5;
    const td = today();
    const days = [...Array(nDays)].map((_, i) => {
      const date = K.addDays(ws, i);
      // off: どの期間（クォーター）にも入らない日
      return { date, i, off: hasTerms() && !K.termFor(S.ds.terms, date), list: dayEntries(date, { withCancelled: true }).filter((e) => e.room === room.name) };
    });
    // この週にかかる期間（例: 「3Q」「3Q / 4Q」）
    const weekTerms = hasTerms() ? S.ds.terms.filter((t) => t.from <= K.ymd(days[days.length - 1].date) && K.ymd(ws) <= t.to) : [];
    const termBadge = !hasTerms() ? ""
      : weekTerms.length ? `<span class="term-badge" title="${esc(weekTerms.map((t) => K.termLabel(t, true)).join(" / "))}">${esc(weekTerms.map((t) => K.termLabel(t)).join(" / "))}${days.some((d) => d.off) ? "・一部期間外" : ""}</span>`
      : `<span class="term-badge off" title="${esc(offTermText(ws))}">授業期間外</span>`;
    const all = days.flatMap((d) => d.list);
    const [t0, t1] = timeRange(all);
    const H = 52;
    const height = ((t1 - t0) / 60) * H;
    const cids = conflictIds();
    const isFav = S.favorites.has(room.name);
    const thisWeek = K.sameDay(ws, K.startOfWeek(td));
    const weekCount = all.filter((e) => !e.cancelled).length;

    const axis = [];
    for (let m = t0; m <= t1; m += 60) axis.push(`<span class="hr" style="top:${((m - t0) / 60) * H}px">${m / 60}:00</span>`);

    const cols = days.map((d) => {
      const lanes = K.assignLanes(d.list);
      const isToday = K.sameDay(d.date, td);
      const blocks = d.list.map((e) => {
        const { lane, lanes: n } = lanes.get(e);
        const style = `top:${((e.start - t0) / 60) * H + 1}px;height:${((e.end - e.start) / 60) * H - 2}px;left:calc(${(lane / n) * 100}% + 2px);width:calc(${100 / n}% - 4px)`;
        return blockHTML(e, style, cids, n > 1 ? "narrow" : "");
      }).join("");
      const now = isToday && nowMin() >= t0 && nowMin() <= t1 ? `<div class="tl-now" style="top:${((nowMin() - t0) / 60) * H}px"></div>` : "";
      return `<div class="wg-col${isToday ? " today" : ""}${d.off ? " off-term" : ""}" style="height:${height}px;background-image:linear-gradient(to bottom, var(--line) 1px, transparent 1px);background-size:100% ${H}px"
        data-act="slot" data-room="${esc(room.name)}" data-date="${K.ymd(d.date)}" data-t0="${t0}" data-t1="${t1}">${blocks}${now}</div>`;
    }).join("");

    const offMark = (d) => (d.off ? `<em class="off-mark" title="${esc(offTermText(d.date))}">期間外</em>` : "");
    const head = days.map((d) => `<div class="wg-day${K.sameDay(d.date, td) ? " today" : ""}${d.off ? " off-term" : ""}">${K.DAYS[d.i]}<small>${d.date.getMonth() + 1}/${d.date.getDate()}</small>${offMark(d)}</div>`).join("");

    const listView = days.map((d) => `<div class="wl-day${K.sameDay(d.date, td) ? " today" : ""}">
      <h3>${K.DAYS[d.i]}曜日 <small>${d.date.getMonth() + 1}/${d.date.getDate()}</small>${offMark(d)}</h3>
      ${d.list.length ? d.list.map((e) => `<button type="button" class="wl-item${e.date ? " dated" : ""}${e.cancelled ? " cancelled" : ""}" data-act="entry" data-id="${esc(e.id)}">
        <span class="t">${fm(e.start)}–${fm(e.end)}</span><span><b>${e.cancelled ? "休講 " : ""}${esc(e.title || "（内容未設定）")}</b> <span class="muted">${esc(e.owner)}</span></span></button>`).join("")
        : `<div class="wl-none">予定なし</div>`}
      ${S.editMode ? `<button class="btn small" type="button" data-act="add-entry" data-room="${esc(room.name)}" data-day="${d.i}">＋ 追加</button>` : ""}
    </div>`).join("");

    view.innerHTML = `<div class="week-head">
        <h2><button type="button" class="fav${isFav ? " on" : ""}" data-act="fav" data-room="${esc(room.name)}" aria-pressed="${isFav}" aria-label="お気に入り" title="お気に入り">${isFav ? "★" : "☆"}</button>${esc(room.name)}</h2>
        <p class="room-meta">${esc(roomMeta(room))}${roomMeta(room) ? " · " : ""}この週 ${weekCount}コマ</p>
        <span class="spacer"></span>
        <div class="week-nav">
          <button class="btn compact-icon" type="button" data-act="shift-week" data-n="-1" title="前の週（←）" aria-label="前の週">‹</button>
          <button class="btn small${thisWeek ? "" : " primary"}" type="button" data-act="shift-week" data-n="0" ${thisWeek ? "disabled" : ""}>今週</button>
          <button class="btn compact-icon" type="button" data-act="shift-week" data-n="1" title="次の週（→）" aria-label="次の週">›</button>
          <span class="week-label">${K.fmtDate(ws, true)} – ${K.fmtDate(K.addDays(ws, nDays - 1))}</span>
          ${termBadge}
        </div>
        <button class="btn small no-print" type="button" data-act="print">印刷</button>
        ${S.editMode ? `<button class="btn small primary no-print" type="button" data-act="add-entry" data-room="${esc(room.name)}">＋ 予定を追加</button>` : ""}
      </div>
      <div class="week-scroll"><div class="week-grid" style="grid-template-columns:56px repeat(${nDays}, minmax(84px, 1fr))">
        <div class="wg-corner"></div>${head}
        <div class="wg-axis" style="height:${height}px">${axis.join("")}</div>${cols}
      </div></div>
      <div class="week-list">${listView}</div>`;
  }

  /* =========================================================
     描画: 空き部屋を探す
  ========================================================= */
  function defaultFreeRange() {
    const m = nowMin();
    const ps = [...S.ds.periods].sort((a, b) => a.start - b.start);
    const cur = ps.find((p) => p.start <= m && m < p.end) || ps.find((p) => p.start > m);
    if (cur) return { from: cur.start, to: cur.end };
    const from = Math.min(Math.ceil(m / 30) * 30, 1380);
    return { from, to: Math.min(from + 90, 1440) };
  }

  function renderFree() {
    if (!S.free) S.free = { date: today(), cap: "", ...defaultFreeRange() };
    const F = S.free;
    const ws = K.startOfWeek(F.date);
    const td = today();
    $("#freeForm").innerHTML = `<div class="free-form">
      <div class="free-row"><span class="lbl">日付</span>
        <div class="day-strip">${K.DAYS.map((d, i) => {
          const dt = K.addDays(ws, i);
          const on = K.sameDay(dt, F.date);
          return `<button type="button" class="day-btn${i === 5 ? " sat" : ""}${i === 6 ? " sun" : ""}${on ? " active" : ""}${K.sameDay(dt, td) ? " today" : ""}" data-act="free-date" data-date="${K.ymd(dt)}" aria-pressed="${on}" data-fk="free-day-${i}">${d}<small>${dt.getMonth() + 1}/${dt.getDate()}</small></button>`;
        }).join("")}</div>
        <input type="date" data-bind="free-date" value="${K.ymd(F.date)}" aria-label="日付" data-fk="free-date">
      </div>
      ${S.ds.periods.length ? `<div class="free-row"><span class="lbl">時限</span><div class="period-chips">${S.ds.periods.map((p, i) =>
        `<button type="button" class="period-chip" data-act="free-period" data-i="${i}" data-fk="free-p-${i}" title="Shift+クリックで連続した時限を選択">${esc(p.name)}<small>${fm(p.start)}</small></button>`).join("")}</div></div>` : ""}
      <div class="free-row"><span class="lbl">時間</span>
        <input type="time" data-bind="free-from" value="${tin(F.from)}" step="300" aria-label="開始" data-fk="free-from"> 〜
        <input type="time" data-bind="free-to" value="${tin(F.to)}" step="300" aria-label="終了" data-fk="free-to">
        <button class="btn small" type="button" data-act="free-now">いまから</button>
      </div>
      ${S.ds.hasCapacity || S.ds.buildings.length ? `<div class="free-row"><span class="lbl">条件</span>
        ${S.ds.hasCapacity ? `<label class="muted" style="font-size:12px">定員 <input type="number" min="0" step="1" data-bind="free-cap" value="${esc(F.cap)}" placeholder="0" data-fk="free-cap"> 人以上</label>` : ""}
        ${buildingSelect()}</div>` : ""}
    </div>`;
    syncPeriodChips();
    renderFreeResults();
  }

  function syncPeriodChips() {
    const F = S.free;
    $$("#freeForm .period-chip").forEach((b) => {
      const p = S.ds.periods[+b.dataset.i];
      const on = p && p.start >= F.from && p.end <= F.to;
      b.classList.toggle("on", !!on);
      b.setAttribute("aria-pressed", !!on);
    });
  }

  function renderFreeResults() {
    const F = S.free;
    const box = $("#freeResults");
    if (!S.ds.rooms.length) { box.innerHTML = emptyData(); return; }
    if (F.from == null || F.to == null || F.to <= F.from) {
      box.innerHTML = `<div class="empty-state">終了時刻は開始時刻より後にしてください。</div>`;
      return;
    }
    const list = dayEntries(F.date);
    const cap = Number(F.cap) || 0;
    const rooms = visibleRooms().filter((r) => !cap || (r.capacity != null && r.capacity >= cap));
    const full = [];
    const partial = [];
    rooms.forEach((r) => {
      const free = K.freeIntervals(list, r.name, F.from, F.to);
      const mine = list.filter((e) => e.room === r.name);
      const before = [...mine].reverse().find((e) => e.end <= F.from);
      const after = mine.find((e) => e.start >= F.to);
      if (free.length === 1 && free[0][0] === F.from && free[0][1] === F.to) full.push({ r, before, after });
      else if (free.some(([a, b]) => b - a >= 10)) partial.push({ r, free: free.filter(([a, b]) => b - a >= 10) });
    });
    full.sort((a, b) => (b.after ? b.after.start : 9999) - (a.after ? a.after.start : 9999) || 0);

    const card = (x, cls, body) => `<button type="button" class="room-card ${cls}" data-act="goto-room" data-room="${esc(x.r.name)}" data-date="${K.ymd(F.date)}">
      <span class="rc-name">${S.favorites.has(x.r.name) ? "★ " : ""}${esc(x.r.name)}</span>${roomMeta(x.r) ? `<span class="rc-meta">${esc(roomMeta(x.r))}</span>` : ""}${body}</button>`;
    const off = offTermText(F.date);
    box.innerHTML = `${off ? `<div class="term-note" role="status">${esc(off)}</div>` : ""}
      <div class="result-head"><h3><span class="dot free"></span> ずっと空いている部屋 ${full.length}</h3><span class="muted">${K.fmtDate(F.date, true)} ${fm(F.from)}–${fm(F.to)}</span></div>
      ${full.length ? `<div class="card-grid">${full.map((x) => card(x, "", `
        <span class="rc-line">${x.after ? `次の予定 <b>${fm(x.after.start)}</b> ${esc(x.after.title)}` : "この後の予定なし"}</span>
        ${x.before ? `<span class="rc-line">前の予定 〜<b>${fm(x.before.end)}</b> ${esc(x.before.title)}</span>` : ""}`)).join("")}</div>`
        : `<div class="empty-state">この時間ずっと空いている部屋はありません。</div>`}
      ${partial.length ? `<div class="result-head"><h3><span class="dot soon"></span> 一部の時間だけ空いている部屋 ${partial.length}</h3></div>
        <div class="card-grid">${partial.map((x) => card(x, "partial", `<span class="rc-line">空き: ${x.free.map(([a, b]) => `<b>${fm(a)}–${fm(b)}</b>`).join("、")}</span>`)).join("")}</div>` : ""}`;
  }

  /* =========================================================
     描画: データ編集
  ========================================================= */
  function renderEdit() {
    const ds = S.ds;
    const root = $("#editRoot");
    const isDraft = !!S.draft;
    const saved = isDraft ? new Date(S.draft.savedAt) : null;
    const issues = isDraft ? [] : ds.issues;
    const checks = ds.entries.filter((e) => /^⚠/.test(e.title));
    const nIssue = issues.length + ds.conflicts.length + checks.length;

    const issueItems = [
      ...ds.conflicts.map(([a, b]) => `<li><span class="lv conflict">重複</span><span>${hasTerms() && (a.term || b.term) ? `[${esc([...new Set([a.term || "共通", b.term || "共通"])].join("・"))}] ` : ""}${esc(a.room)} ${a.date ? esc(a.date) : K.DAYS[a.day] + "曜"}:
        「${esc(a.title)}」${fm(a.start)}–${fm(a.end)} と「${esc(b.title)}」${fm(b.start)}–${fm(b.end)} が重なっています</span>
        <button class="btn small" type="button" data-act="edit-entry" data-id="${esc(a.id)}">左を編集</button><button class="btn small" type="button" data-act="edit-entry" data-id="${esc(b.id)}">右を編集</button></li>`),
      ...checks.map((e) => `<li><span class="lv warn">要確認</span><span>${esc(e.room)} ${e.date ? esc(e.date) : K.DAYS[e.day] + "曜"} ${fm(e.start)}–${fm(e.end)}「${esc(e.title)}」${e.row ? `（${e.row}行目）` : ""} は読み取りが崩れている可能性があります</span>
        <button class="btn small" type="button" data-act="edit-entry" data-id="${esc(e.id)}">編集</button></li>`),
      ...issues.map((i) => `<li><span class="lv ${i.level}">${i.level === "error" ? "読めない行" : "注意"}</span><span>${i.sheet ? `「${esc(i.sheet)}」` : ""}${i.row ? `${i.row}行目: ` : ""}${esc(i.msg)}</span></li>`),
    ];

    let body = "";
    if (S.editSub === "entries") body = editEntriesHTML();
    else if (S.editSub === "rooms") body = editRoomsHTML();
    else body = editPeriodsHTML();

    root.innerHTML = `
      <div class="edit-state${isDraft ? " draft" : ""}">
        <div class="grow">
          ${isDraft ? `<b>✎ このブラウザで編集中のデータ</b>（${K.pad2(saved.getHours())}:${K.pad2(saved.getMinutes())} 自動保存）`
            : `<b>公開データ（${esc(S.published ? S.published.src : "未読み込み")}）を表示中</b>`}
          <p>ここでの変更はこのブラウザにだけ自動保存されます。みんなに反映するには <b>「Excel に書き出す」</b> でできた schedule.xlsx を、サイトの schedule.xlsx と置き換えてください。</p>
          ${hasTerms() ? `<p class="term-list">期間（クォーター）: ${ds.terms.map((t) => esc(K.termLabel(t, true))).join(" · ")}<br><span class="muted">期間の日付を変えるときは、Excel の「期間」シートを書き換えて取り込んでください。</span></p>` : ""}
        </div>
        ${isDraft ? `<button class="btn danger" type="button" data-act="discard-draft">編集を破棄</button>` : ""}
      </div>

      <div class="edit-actions">
        <div class="action-group"><span class="group-label">入力</span>
          <button class="btn primary" type="button" data-act="add-entry">＋ 予定を追加 <kbd>N</kbd></button>
          <button class="btn" type="button" data-act="import-file">ファイルから取り込む</button>
          <button class="btn" type="button" data-act="import-paste">貼り付けて取り込む</button>
        </div>
        <div class="action-group"><span class="group-label">書き出し</span>
          <button class="btn" type="button" data-act="export-xlsx">Excel に書き出す</button>
          <button class="btn" type="button" data-act="export-csv">CSV</button>
          <button class="btn" type="button" data-act="export-json">JSON</button>
          <button class="btn ghost" type="button" data-act="export-template" title="見出しと使い方だけの空のファイル">空のテンプレート</button>
        </div>
        <div class="action-group">
          <label class="switch" title="ほかの画面でも、時間割の空いている所をクリックして予定を追加・編集できるようにします"><input type="checkbox" data-bind="edit-mode" ${S.editMode ? "checked" : ""}> ほかの画面でも編集する</label>
          <button class="btn ghost" type="button" data-act="undo" ${S.undo.length ? "" : "disabled"} title="Ctrl+Z">↶ 元に戻す</button>
        </div>
      </div>

      ${nIssue ? `<details class="issues" ${nIssue <= 10 ? "open" : ""}><summary>確認が必要な項目:
        ${ds.conflicts.length ? `<span class="wrn">時間の重複 ${ds.conflicts.length}件</span>` : ""}
        ${checks.length ? `<span class="wrn">要確認 ${checks.length}件</span>` : ""}
        ${issues.filter((i) => i.level === "error").length ? `<span class="err">読み取れない行 ${issues.filter((i) => i.level === "error").length}件</span>` : ""}
        ${issues.filter((i) => i.level !== "error").length ? `<span class="wrn">注意 ${issues.filter((i) => i.level !== "error").length}件</span>` : ""}
        </summary><ul>${issueItems.join("")}</ul></details>` : ""}

      <div class="subtabs" role="tablist">
        <button class="subtab" type="button" role="tab" data-act="edit-sub" data-v="entries" aria-selected="${S.editSub === "entries"}">予定 ${ds.entries.length}</button>
        <button class="subtab" type="button" role="tab" data-act="edit-sub" data-v="rooms" aria-selected="${S.editSub === "rooms"}">部屋 ${ds.rooms.length}</button>
        <button class="subtab" type="button" role="tab" data-act="edit-sub" data-v="periods" aria-selected="${S.editSub === "periods"}">時限 ${ds.periods.length}</button>
        ${S.editSub === "entries" ? `<div class="tools">
          <input type="search" data-bind="edit-q" value="${esc(S.editQuery)}" placeholder="予定を絞り込み" aria-label="予定を絞り込み" data-fk="edit-q">
          <select data-bind="edit-sort" aria-label="並び順">
            <option value="room" ${S.editSort === "room" ? "selected" : ""}>部屋順</option>
            <option value="day" ${S.editSort === "day" ? "selected" : ""}>曜日・時間順</option>
            <option value="title" ${S.editSort === "title" ? "selected" : ""}>内容順</option>
            ${hasTerms() ? `<option value="term" ${S.editSort === "term" ? "selected" : ""}>期間順</option>` : ""}
          </select></div>` : ""}
      </div>
      ${body}`;
  }

  /** 編集画面の予定一覧（絞り込み・並べ替え済み） */
  function editList() {
    const ds = S.ds;
    const ts = terms(S.editQuery);
    const list = ds.entries.filter((e) => !ts.length || matchAll(entryHay(e), ts));
    if (S.editSort === "room") return K.sortEntries(list, ds.rooms.map((r) => r.name));
    if (S.editSort === "term" && ds.terms.length) {
      const ti = (e) => { const i = ds.terms.findIndex((t) => t.name === e.term); return i < 0 ? ds.terms.length : i; };
      return K.sortEntries(list, ds.rooms.map((r) => r.name)).sort((a, b) => ti(a) - ti(b));
    }
    if (S.editSort === "day") return list.sort((a, b) => a.day - b.day || a.start - b.start || a.room.localeCompare(b.room, "ja", { numeric: true }));
    return list.sort((a, b) => a.title.localeCompare(b.title, "ja") || a.day - b.day || a.start - b.start);
  }

  function editFootHTML(list) {
    const shown = Math.min(list.length, S.editLimit);
    return `${shown < list.length ? `${shown} / ${list.length}件を表示 <button class="btn small" type="button" data-act="edit-more">さらに表示</button>` : `${list.length} / ${S.ds.entries.length}件を表示`}
      ${S.selected.size ? `<span class="spacer"></span><b>${S.selected.size}件を選択中</b>
        <button class="btn small danger" type="button" data-act="del-selected">選択した予定を削除</button>
        <button class="btn small ghost" type="button" data-act="clear-selected">選択を解除</button>` : ""}`;
  }

  /** チェックボックスの変更は表全体を描き直さずに反映する（予定が多い時に重くならないように） */
  function syncSelection() {
    $$('#editRoot input[data-bind="sel"]').forEach((cb) => {
      const on = S.selected.has(cb.dataset.id);
      cb.checked = on;
      cb.closest("tr").classList.toggle("sel", on);
    });
    const list = editList();
    const all = $('#editRoot input[data-bind="sel-all"]');
    if (all) all.checked = list.length > 0 && list.every((e) => S.selected.has(e.id));
    const foot = $("#editFoot");
    if (foot) foot.innerHTML = editFootHTML(list);
  }

  function editEntriesHTML() {
    const ds = S.ds;
    const list = editList();
    const cids = conflictIds();
    const allSel = list.length > 0 && list.every((e) => S.selected.has(e.id));
    if (!ds.entries.length) return emptyData();
    const withTerm = hasTerms();
    const termCell = (e) => (!withTerm ? "" : `<td>${e.term ? `${esc(e.term)}${termByName(e.term) ? "" : '<span class="tag warn" title="「期間」シートにない期間名です（いつでも表示されます）">日付なし</span>'}` : '<span class="muted">共通</span>'}</td>`);
    return `<div class="table-wrap"><table class="data">
      <thead><tr><th class="chk"><input type="checkbox" data-bind="sel-all" ${allSel ? "checked" : ""} aria-label="表示中の予定をすべて選択"></th>
        <th>部屋</th>${withTerm ? "<th>期間</th>" : ""}<th>いつ</th><th>時間</th><th>内容</th><th class="hide-sm">担当者</th><th class="hide-sm">備考</th><th></th></tr></thead>
      <tbody>${list.slice(0, S.editLimit).map((e) => `<tr class="${S.selected.has(e.id) ? "sel" : ""}${/^⚠/.test(e.title) ? " needs-check" : ""}">
        <td class="chk"><input type="checkbox" data-bind="sel" data-id="${esc(e.id)}" ${S.selected.has(e.id) ? "checked" : ""} aria-label="選択"></td>
        <td>${esc(e.room)}</td>${termCell(e)}
        <td>${e.date ?`${esc(K.fmtDate(K.parseYmd(e.date), true))}<span class="tag">この日だけ</span>` : `毎週${K.DAYS[e.day]}`}${K.isCancel(e) ? '<span class="tag">取消</span>' : ""}</td>
        <td class="t">${fm(e.start)}–${fm(e.end)}${cids.has(e.id) ? '<span class="tag warn" title="時間が重なっています">重複</span>' : ""}</td>
        <td>${esc(e.title)}</td><td class="hide-sm">${esc(e.owner)}</td><td class="hide-sm">${esc(e.note)}</td>
        <td class="acts"><button class="btn small" type="button" data-act="edit-entry" data-id="${esc(e.id)}">編集</button>
          <button class="btn small ghost" type="button" data-act="dup-entry" data-id="${esc(e.id)}" title="複製">複製</button>
          <button class="btn small ghost danger" type="button" data-act="del-entry" data-id="${esc(e.id)}" title="削除" aria-label="削除">✕</button></td>
      </tr>`).join("")}</tbody></table>
      <div class="table-foot" id="editFoot">${editFootHTML(list)}</div></div>`;
  }

  function editRoomsHTML() {
    const ds = S.ds;
    const counts = new Map();
    ds.entries.forEach((e) => counts.set(e.room, (counts.get(e.room) || 0) + 1));
    return `<p class="muted" style="font-size:12px;margin:0 0 8px">部屋の並び順・建物・定員を設定できます（建物で絞り込み、定員で空き部屋検索ができるようになります）。部屋名を変えると、その部屋の予定もまとめて変わります。</p>
      <div class="table-wrap"><table class="data">
      <thead><tr><th>部屋名</th><th>建物</th><th>定員</th><th class="hide-sm">備考・設備</th><th>予定</th><th></th></tr></thead>
      <tbody>${ds.rooms.map((r, i) => `<tr>
        <td><input class="inline-input" data-bind="room-field" data-i="${i}" data-f="name" value="${esc(r.name)}" data-fk="room-${i}-name" aria-label="部屋名"></td>
        <td><input class="inline-input" data-bind="room-field" data-i="${i}" data-f="building" value="${esc(r.building)}" data-fk="room-${i}-building" placeholder="例: 本館" aria-label="建物"></td>
        <td><input class="inline-input num" type="number" min="0" data-bind="room-field" data-i="${i}" data-f="capacity" value="${r.capacity ?? ""}" data-fk="room-${i}-capacity" aria-label="定員"></td>
        <td class="hide-sm"><input class="inline-input" data-bind="room-field" data-i="${i}" data-f="note" value="${esc(r.note)}" data-fk="room-${i}-note" placeholder="例: プロジェクターあり" aria-label="備考"></td>
        <td class="t">${counts.get(r.name) || 0}件</td>
        <td class="acts"><button class="btn small ghost" type="button" data-act="move-room" data-i="${i}" data-n="-1" ${i === 0 ? "disabled" : ""} aria-label="上へ">↑</button>
          <button class="btn small ghost" type="button" data-act="move-room" data-i="${i}" data-n="1" ${i === ds.rooms.length - 1 ? "disabled" : ""} aria-label="下へ">↓</button>
          <button class="btn small ghost danger" type="button" data-act="del-room" data-i="${i}" aria-label="削除" title="部屋と、その部屋の予定を削除">✕</button></td>
      </tr>`).join("")}</tbody></table>
      <div class="table-foot"><button class="btn small" type="button" data-act="add-room">＋ 部屋を追加</button></div></div>`;
  }

  function editPeriodsHTML() {
    const ds = S.ds;
    return `<p class="muted" style="font-size:12px;margin:0 0 8px">時限の定義です。予定の入力（「2限」と書く・時限ボタン）や空き部屋検索で使われます。Excel に書き出すと「時限」シートに保存されます。</p>
      <div class="table-wrap"><table class="data">
      <thead><tr><th>名前</th><th>開始</th><th>終了</th><th></th></tr></thead>
      <tbody>${ds.periods.map((p, i) => `<tr>
        <td><input class="inline-input" data-bind="period-field" data-i="${i}" data-f="name" value="${esc(p.name)}" data-fk="period-${i}-name" aria-label="名前"></td>
        <td><input class="inline-input time" type="time" step="300" data-bind="period-field" data-i="${i}" data-f="start" value="${tin(p.start)}" data-fk="period-${i}-start" aria-label="開始"></td>
        <td><input class="inline-input time" type="time" step="300" data-bind="period-field" data-i="${i}" data-f="end" value="${tin(p.end)}" data-fk="period-${i}-end" aria-label="終了"></td>
        <td class="acts"><button class="btn small ghost danger" type="button" data-act="del-period" data-i="${i}" aria-label="削除">✕</button></td>
      </tr>`).join("")}</tbody></table>
      <div class="table-foot"><button class="btn small" type="button" data-act="add-period">＋ 時限を追加</button></div></div>`;
  }

  /* =========================================================
     編集（このブラウザに下書き保存）
  ========================================================= */
  function snapshotForDraft() {
    const ds = S.ds;
    return {
      entries: ds.entries.map((e) => ({
        id: e.id, room: e.room, day: e.day, date: e.date || null, start: e.start, end: e.end, title: e.title || "", owner: e.owner || "", note: e.note || "",
        term: e.term || null, termFrom: e.termFrom || null, termTo: e.termTo || null,
      })),
      rooms: ds.rooms.map((r) => ({ name: r.name, building: r.building || "", capacity: r.capacity ?? null, note: r.note || "" })),
      periods: ds.periods.map((p) => ({ name: p.name, start: p.start, end: p.end })),
      terms: ds.terms.map((t) => ({ name: t.name, from: t.from, to: t.to })),
      baseSig: S.published ? S.published.sig : "",
      savedAt: Date.now(),
    };
  }

  function saveDraft() {
    if (!S.draft) { store.del(KEY.draft); return; }
    if (!store.set(KEY.draft, S.draft)) toast("このブラウザでは編集内容を保存できません（プライベートモードなど）。書き出しは可能です", { error: true, ms: 6000 });
  }

  function loadDraft() {
    const d = store.get(KEY.draft, null);
    if (!d || !Array.isArray(d.entries)) return null;
    d.entries = d.entries.filter((e) => e && e.room && e.start != null && e.end != null).map((e) => K.makeEntry(e));
    d.rooms = Array.isArray(d.rooms) ? d.rooms : [];
    d.periods = Array.isArray(d.periods) ? d.periods : [];
    d.terms = Array.isArray(d.terms) ? d.terms.filter((t) => t && t.name && K.parseYmd(t.from) && K.parseYmd(t.to)) : [];
    return d;
  }

  /** 元に戻す用の記録。部屋名の変更でお気に入りや選択中の部屋も変わるので一緒に覚える */
  const undoPoint = () => ({ draft: S.draft ? JSON.stringify(S.draft) : null, favs: [...S.favorites], room: S.room });

  function pushUndo(point) {
    S.undo.push(point);
    if (S.undo.length > 50) S.undo.shift();
  }

  function mutate(fn, msg) {
    const before = undoPoint();
    if (!S.draft) S.draft = snapshotForDraft();
    fn(S.draft);
    S.draft.savedAt = Date.now();
    pushUndo(before);
    saveDraft();
    refreshDataset();
    renderAll();
    if (msg) toast(msg, { action: "元に戻す", onAction: undo });
  }

  function undo() {
    if (!S.undo.length) { toast("元に戻せる操作はありません"); return; }
    $$("#toasts .toast").forEach((t) => { if (t.querySelector("button")) t.remove(); });
    const snap = S.undo.pop();
    S.draft = snap.draft ? JSON.parse(snap.draft) : null;
    S.favorites = new Set(snap.favs);
    store.set(KEY.fav, snap.favs);
    S.room = snap.room;
    saveDraft();
    refreshDataset();
    renderAll();
    toast("元に戻しました");
  }

  function discardDraft() {
    if (!S.draft) return;
    pushUndo(undoPoint());
    S.draft = null;
    saveDraft();
    refreshDataset();
    renderAll();
    toast("編集を破棄して公開データに戻しました", { action: "元に戻す", onAction: undo });
  }

  function deleteEntries(ids) {
    const set = new Set(ids);
    const n = S.ds.entries.filter((e) => set.has(e.id)).length;
    if (!n) return;
    ids.forEach((id) => S.selected.delete(id)); // 消した分だけ選択から外す（他の選択は残す）
    mutate((d) => { d.entries = d.entries.filter((e) => !set.has(e.id)); }, `${n}件の予定を削除しました`);
  }

  function renameRoom(d, from, to) {
    d.entries.forEach((e) => { if (e.room === from) e.room = to; });
    if (S.room === from) S.room = to;
    if (S.favorites.has(from)) { S.favorites.delete(from); S.favorites.add(to); store.set(KEY.fav, [...S.favorites]); }
  }

  /* =========================================================
     書き出し
  ========================================================= */
  function exportData(kind, template) {
    const ds = S.ds;
    const entries = template ? [] : ds.entries;
    const rooms = template ? [] : ds.rooms;
    const terms = template ? [] : ds.terms;
    const order = rooms.map((r) => r.name);
    if (kind === "xlsx") {
      if (!window.XLSX) { toast("Excel 用のライブラリを読み込めていません。CSV で書き出してください", { error: true }); return; }
      const wb = XLSX.utils.book_new();
      const add = (aoa, name, widths) => {
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws["!cols"] = widths.map((w) => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      const SCHED_W = [16, 6, 12, 7, 7, 26, 12, 20];
      if (terms.length) {
        // 期間（クォーター）ごとのシート＋「期間」シート。Excel のシート名に使えない文字は置き換える
        const used = new Set(["期間", "部屋", "時限", "使い方"]);
        const sheetName = (name) => {
          const base = String(name).replace(/[\\\/?*\[\]:]/g, "_").slice(0, 28) || "シート";
          let n = base;
          for (let i = 2; used.has(n); i++) n = `${base}(${i})`;
          used.add(n);
          return n;
        };
        const named = terms.map((t) => ({ ...t, sheet: sheetName(t.name) }));
        const common = entries.filter((e) => !termByName(e.term));
        add(K.toTermsAoa(named.map((t) => ({ ...t, name: t.sheet }))), "期間", [12, 12, 12]);
        named.forEach((t) => add(K.toScheduleAoa(entries.filter((e) => e.term === t.name), order), t.sheet, SCHED_W));
        if (common.length) add(K.toScheduleAoa(common, order), sheetName("時間割"), SCHED_W);
      } else {
        add(K.toScheduleAoa(entries, order), "時間割", SCHED_W);
      }
      add(K.toRoomsAoa(rooms), "部屋", [16, 12, 6, 28]);
      add(K.toPeriodsAoa(ds.periods), "時限", [8, 7, 7]);
      add(K.USAGE_LINES.map((l) => [l]), "使い方", [110]);
      XLSX.writeFile(wb, "schedule.xlsx");
      toast(template ? "空のテンプレートを書き出しました"
        : `schedule.xlsx を書き出しました${terms.length ? "（期間ごとのシートに分けています）" : ""}。サイトの schedule.xlsx と置き換えると反映されます`, { ms: 6000 });
    } else if (kind === "csv") {
      download(K.toCSV(K.toScheduleAoa(entries, order, { term: terms.length > 0 })), "schedule.csv", "text/csv;charset=utf-8");
      toast(`schedule.csv を書き出しました（部屋・時限${terms.length ? "・期間の日付" : ""}の設定は含まれません）`);
    } else {
      download(JSON.stringify(K.toJSON(entries, rooms, ds.periods, terms), null, 2), "schedule.json", "application/json");
      toast("schedule.json を書き出しました");
    }
  }

  /* =========================================================
     ダイアログ: 予定の詳細
  ========================================================= */
  function openDialog(dlg) {
    if (!dlg.open) dlg.showModal();
  }

  function openDetail(id) {
    const e = entryById(id);
    if (!e) return;
    S.detailId = id;
    const r = roomByName(e.room);
    // 連続したコマをまとめて表示している場合は、まとめた時間で見せる
    const mv = mergedView.get(id);
    const parts = mv ? mv.partIds.map(entryById).filter(Boolean) : [e];
    const start = Math.min(...parts.map((p) => p.start));
    const end = Math.max(...parts.map((p) => p.end));
    const pl = periodLabel(start, end);
    const cancelled = !e.date && S.tab !== "week" && dayEntries(S.date, { withCancelled: true }).some((x) => x.id === id && x.cancelled);
    const overlaps = K.overlapsWith(S.ds.entries, e, [e.id]);
    const canEdit = S.editMode || S.tab === "edit";
    const ids = parts.map((p) => p.id).join(",");
    const term = termByName(e.term);
    // 毎週の予定を、その期間外の日付から開いた時は、期間の最初の週の時間割へ移動する
    const vd = K.ymd(viewDate());
    const jumpDate = e.date || (term && !(term.from <= vd && vd <= term.to) ? term.from : "");
    const termRow = !hasTerms() ? ""
      : term ? `<dt>期間</dt><dd>${esc(K.termLabel(term, true))}</dd>`
      : `<dt>期間</dt><dd>${e.term ? `${esc(e.term)} <span class="muted">（日付の設定なし）</span>` : "すべての期間（共通）"}</dd>`;
    $("#detailBody").innerHTML = `
      <div class="detail-head">
        <div>
          <span class="status-pill ${e.date ? "status-soon" : "status-busy"}" style="display:inline-block">${e.date ? "この日だけ" : "毎週"}</span>
          <h2>${esc(e.title || "（内容未設定）")}</h2>
          <div class="detail-time">${pl ? esc(pl) + " · " : ""}${fm(start)} – ${fm(end)}（${K.fmtDuration(end - start)}）</div>
        </div>
        <button class="icon-btn plain" type="button" data-close aria-label="閉じる">✕</button>
      </div>
      <dl class="detail-list">
        <dt>部屋</dt><dd>${esc(e.room)}${roomMeta(r) ? ` <span class="muted">（${esc(roomMeta(r))}）</span>` : ""}</dd>
        <dt>いつ</dt><dd>${esc(whenLabel(e))}${cancelled ? ` <b style="color:var(--amber)">※ ${K.fmtDate(S.date)} は休講</b>` : ""}</dd>
        ${termRow}
        ${e.owner ? `<dt>担当者</dt><dd>${esc(e.owner)}</dd>` : ""}
        ${e.note ? `<dt>備考</dt><dd>${esc(e.note)}</dd>` : ""}
        ${parts.some((p) => p.row) ? `<dt>元データ</dt><dd class="muted">${parts.map((p) => p.row).filter(Boolean).join("・")}行目${parts.length > 1 ? `（${parts.length}コマ連続をまとめて表示）` : ""}</dd>` : ""}
        ${/^⚠/.test(e.title) ? `<dt>要確認</dt><dd style="color:var(--gold-text)">読み取りが崩れている可能性がある行です。元の資料と照合してください</dd>` : ""}
        ${overlaps.length ? `<dt>⚠ 重複</dt><dd style="color:var(--amber)">${overlaps.map((o) => `${fm(o.start)}–${fm(o.end)} ${esc(o.title)}`).join("、")} と時間が重なっています</dd>` : ""}
      </dl>
      <div class="detail-actions">
        <button class="btn" type="button" data-act="goto-room" data-room="${esc(e.room)}" ${jumpDate ? `data-date="${esc(jumpDate)}"` : ""}>この部屋の時間割を見る</button>
        <span class="spacer"></span>
        ${canEdit ? `<button class="btn" type="button" data-act="edit-entry" data-id="${esc(e.id)}" ${parts.length > 1 ? 'title="連続したコマのうち最初のコマを編集します"' : ""}>編集${parts.length > 1 ? "（最初のコマ）" : ""}</button>
          <button class="btn ghost" type="button" data-act="dup-entry" data-id="${esc(e.id)}">複製</button>
          <button class="btn ghost danger" type="button" data-act="del-entry" data-id="${esc(ids)}">削除${parts.length > 1 ? `（${parts.length}コマ）` : ""}</button>` : ""}
      </div>`;
    openDialog($("#dlgDetail"));
  }

  /* =========================================================
     ダイアログ: 予定の追加・編集
  ========================================================= */
  const form = () => $("#entryForm");
  const fel = () => form().elements;

  /**
   * @param {object} opt { id: 編集する予定, copyOf: 複製元, room, day, date, start, end }
   */
  function openForm(opt = {}) {
    $("#dlgDetail").open && $("#dlgDetail").close();
    const f = fel();
    const src = opt.id ? entryById(opt.id) : opt.copyOf ? entryById(opt.copyOf) : null;
    S.formCtx = { id: opt.id && src ? src.id : null, days: new Set(), anchor: null };
    $("#formTitle").textContent = S.formCtx.id ? "予定を編集" : src ? "予定を複製" : "予定を追加";
    $("#formDelete").hidden = !S.formCtx.id;
    $("#roomOptions").innerHTML = S.ds.rooms.map((r) => `<option value="${esc(r.name)}">`).join("");

    const def = defaultFreeRange();
    const v = src || {
      room: opt.room ?? (S.tab === "week" ? S.room : "") ?? "",
      day: opt.day ?? K.dayIndexOf(S.tab === "week" ? S.weekDate : S.date),
      date: opt.date || null,
      start: opt.start ?? def.from,
      end: opt.end ?? def.to,
      title: "", owner: "", note: "",
    };
    f.room.value = v.room || "";
    f.mode.value = v.date ? "date" : "weekly";
    f.date.value = v.date || K.ymd(opt.dateHint || S.date);
    S.formCtx.days = new Set(v.date ? [] : [v.day]);
    f.start.value = tin(v.start);
    f.end.value = tin(v.end);
    f.title.value = v.title || "";
    f.owner.value = v.owner || "";
    f.note.value = v.note || "";

    // 期間（クォーター）: 編集中の予定の期間、なければ表示中の日付の期間を初期値にする
    const terms = S.ds.terms;
    $("#termField").hidden = !terms.length;
    S.formCtx.srcTerm = src ? src.term || null : null;
    S.formCtx.termTouched = !!src;
    if (terms.length) {
      const ctxDate = opt.dateHint || (opt.date ? K.parseYmd(opt.date) : null) || viewDate();
      const c = K.termContext(terms, ctxDate);
      const def = src ? src.term || "" : (c.current || c.next || c.prev || {}).name || "";
      const orphan = def && !termByName(def) ? `<option value="${esc(def)}">${esc(def)}（日付の設定なし）</option>` : "";
      f.term.innerHTML = terms.map((t) => `<option value="${esc(t.name)}">${esc(K.termLabel(t, true))}</option>`).join("") + orphan +
        `<option value="">すべての期間（共通）</option>`;
      f.term.value = def;
    } else f.term.innerHTML = "";

    $("#formDays").innerHTML = K.DAYS.map((d, i) => `<button type="button" class="day-toggle" data-day="${i}" aria-pressed="false" aria-label="${d}曜日">${d}</button>`).join("");
    $("#formPeriods").innerHTML = S.ds.periods.map((p, i) => `<button type="button" class="period-chip" data-pi="${i}">${esc(p.name)}<small>${fm(p.start)}</small></button>`).join("");
    syncForm();
    openDialog($("#dlgForm"));
    setTimeout(() => (f.room.value ? f.title : f.room).focus(), 30);
  }

  function readForm() {
    const f = fel();
    return {
      room: K.nfkc(f.room.value),
      mode: f.mode.value,
      date: f.date.value,
      days: [...S.formCtx.days].sort(),
      start: tout(f.start.value),
      end: tout(f.end.value),
      title: f.title.value.trim(),
      owner: f.owner.value.trim(),
      note: f.note.value.trim(),
      // 期間の欄がない時（期間のないデータ）は、元の予定の期間名をそのまま残す
      term: S.ds.terms.length ? f.term.value || null : S.formCtx.srcTerm || null,
    };
  }

  function formCandidates(v) {
    const t = termByName(v.term);
    const tf = { term: v.term || null, termFrom: t ? t.from : null, termTo: t ? t.to : null };
    if (v.mode === "date") {
      const d = K.parseYmd(v.date);
      return d ? [{ room: v.room, date: v.date, day: K.dayIndexOf(d), start: v.start, end: v.end, ...tf }] : [];
    }
    return v.days.map((day) => ({ room: v.room, date: null, day, start: v.start, end: v.end, ...tf }));
  }

  function syncForm() {
    const f = fel();
    const v = readForm();
    const weekly = v.mode === "weekly";
    $("#formDays").hidden = !weekly;
    f.date.hidden = weekly;
    $("#modeHint").textContent = weekly ? "曜日は複数選べます（同じ時間の予定をまとめて登録）" : "臨時の予約や、内容を「休講」で始めてその日の授業を取り消すときに使います";
    $$("#formDays .day-toggle").forEach((b) => b.setAttribute("aria-pressed", S.formCtx.days.has(+b.dataset.day)));
    $$("#formPeriods .period-chip").forEach((b) => {
      const p = S.ds.periods[+b.dataset.pi];
      b.classList.toggle("on", v.start !== null && v.end !== null && p.start >= v.start && p.end <= v.end);
    });
    const term = termByName(v.term);
    if (S.ds.terms.length) {
      $("#termHint").textContent = term ? `${K.termLabel(term, true)} の間だけ表示されます`
        : v.term ? "「期間」シートにない期間名のため、いつでも表示されます" : "期間に関係なく、いつでも表示されます";
    }
    const warn = $("#formWarn");
    warn.className = "form-warn";
    if (v.start !== null && v.end !== null && v.end <= v.start) { warn.classList.add("error"); warn.textContent = "終了時刻は開始時刻より後にしてください"; return; }
    const outside = !weekly && term && K.parseYmd(v.date) && (v.date < term.from || v.date > term.to)
      ? `⚠ 日付が期間「${K.termLabel(term)}」の外なので、このままでは表示されません。期間を選び直してください` : "";
    if (!v.room || v.start === null || v.end === null) { warn.textContent = outside; return; }
    const ignore = S.formCtx.id ? [S.formCtx.id] : [];
    const hits = formCandidates(v).flatMap((c) => K.overlapsWith(S.ds.entries, c, ignore).map((o) => ({ c, o })));
    const overlapMsg = hits.length
      ? "⚠ 時間が重なる予定があります: " + hits.slice(0, 3).map(({ o }) => `${o.term && term ? "" : o.term ? o.term + " " : ""}${o.date ? o.date : K.DAYS[o.day] + "曜"} ${fm(o.start)}–${fm(o.end)}「${o.title}」`).join("、") + (hits.length > 3 ? ` ほか${hits.length - 3}件` : "") + "（このまま保存もできます）"
      : "";
    warn.textContent = [outside, overlapMsg].filter(Boolean).join(" ");
  }

  /** 日付指定の予定では、期間を手で選んでいなければ日付に合う期間を選ぶ */
  function autoPickTerm() {
    const f = fel();
    if (!S.ds.terms.length || S.formCtx.termTouched || f.mode.value !== "date") return;
    const t = K.termFor(S.ds.terms, f.date.value);
    if (t) f.term.value = t.name;
  }

  function submitForm() {
    const v = readForm();
    const warn = $("#formWarn");
    const fail = (msg, el) => { warn.className = "form-warn error"; warn.textContent = msg; if (el) el.focus(); };
    const f = fel();
    if (!v.room) return fail("部屋を入力してください", f.room);
    if (v.mode === "weekly" && !v.days.length) return fail("曜日を1つ以上選んでください");
    if (v.mode === "date" && !K.parseYmd(v.date)) return fail("日付を入力してください", f.date);
    if (v.start === null || v.end === null) return fail("開始・終了の時刻を入力してください", f.start);
    if (v.end <= v.start) return fail("終了時刻は開始時刻より後にしてください", f.end);
    const editingId = S.formCtx.id;
    const created = formCandidates(v).map((c) => K.makeEntry({ ...c, title: v.title, owner: v.owner, note: v.note }));
    mutate((d) => {
      if (editingId) {
        const idx = d.entries.findIndex((e) => e.id === editingId);
        if (idx >= 0) {
          created[0].id = editingId;
          d.entries.splice(idx, 1, ...created);
        } else d.entries.push(...created);
      } else d.entries.push(...created);
      if (!d.rooms.some((r) => r.name === v.room)) d.rooms.push({ name: v.room, building: "", capacity: null, note: "" });
    }, editingId ? "予定を更新しました" : `${created.length}件の予定を追加しました`);
    S.room = v.room;
    $("#dlgForm").close();
  }

  function setupForm() {
    const fm0 = form();
    const f = fel();
    fm0.addEventListener("submit", (e) => { e.preventDefault(); submitForm(); });
    // 期間の自動選択は、フォーム全体の syncForm より先に動かす（要素側のリスナーが先に呼ばれる）
    f.term.addEventListener("change", () => { S.formCtx.termTouched = true; });
    f.date.addEventListener("change", autoPickTerm);
    $$('input[name="mode"]', fm0).forEach((r) => r.addEventListener("change", autoPickTerm));
    fm0.addEventListener("input", syncForm);
    fm0.addEventListener("change", syncForm);
    $("#formDays").addEventListener("click", (e) => {
      const b = e.target.closest(".day-toggle");
      if (!b) return;
      const d = +b.dataset.day;
      if (S.formCtx.days.has(d)) S.formCtx.days.delete(d); else S.formCtx.days.add(d);
      syncForm();
    });
    $("#formPeriods").addEventListener("click", (e) => {
      const b = e.target.closest(".period-chip");
      if (!b) return;
      const i = +b.dataset.pi;
      const p = S.ds.periods[i];
      if (e.shiftKey && S.formCtx.anchor !== null) {
        const a = S.ds.periods[S.formCtx.anchor];
        f.start.value = tin(Math.min(a.start, p.start));
        f.end.value = tin(Math.max(a.end, p.end));
      } else {
        f.start.value = tin(p.start);
        f.end.value = tin(p.end);
        S.formCtx.anchor = i;
      }
      syncForm();
    });
    $("#formDelete").addEventListener("click", () => {
      const id = S.formCtx.id;
      $("#dlgForm").close();
      if (id) deleteEntries([id]);
    });
  }

  /* =========================================================
     ダイアログ: 取り込み
  ========================================================= */
  function openImport(ctx) {
    S.importCtx = Object.assign({ view: "file", text: "", result: null, label: "", mode: "replace" }, ctx);
    renderImport();
    openDialog($("#dlgImport"));
    if (S.importCtx.view === "paste" && !S.importCtx.result) setTimeout(() => { const t = $("#pasteArea"); if (t) t.focus(); }, 30);
  }

  function renderImport() {
    const c = S.importCtx;
    const body = $("#importBody");
    if (c.result) {
      const r = c.result;
      const rooms = new Set(r.entries.map((e) => e.room));
      const errs = r.issues.filter((i) => i.level === "error");
      const conflicts = K.findConflicts(r.entries).length;
      body.innerHTML = `
        <p style="margin:0 0 8px">${esc(c.label)} を読み取りました。</p>
        <div class="import-summary">
          <div class="stat"><b>${r.entries.length}</b><span>件の予定</span></div>
          <div class="stat"><b>${rooms.size}</b><span>部屋</span></div>
          ${r.periods.length ? `<div class="stat"><b>${r.periods.length}</b><span>時限の定義</span></div>` : ""}
          ${(r.terms || []).length ? `<div class="stat"><b>${r.terms.length}</b><span>期間（クォーター）</span></div>` : ""}
          <div class="stat"><b style="color:${errs.length ? "var(--amber)" : "inherit"}">${errs.length}</b><span>読み取れない行</span></div>
          ${conflicts ? `<div class="stat"><b style="color:var(--gold-text)">${conflicts}</b><span>時間の重複</span></div>` : ""}
        </div>
        ${(r.terms || []).length ? `<p class="term-list">期間: ${r.terms.map((t) => `${esc(K.termLabel(t, true))} ${r.entries.filter((e) => e.term === t.name).length}件`).join(" · ")}${r.entries.some((e) => !e.term) ? ` · 共通 ${r.entries.filter((e) => !e.term).length}件` : ""}</p>` : ""}
        ${r.issues.length ? `<details class="issues" open><summary>メッセージ ${r.issues.length}件</summary><ul>${r.issues.slice(0, 50).map((i) =>
          `<li><span class="lv ${i.level}">${i.level === "error" ? "読めない行" : "注意"}</span><span>${i.sheet ? `「${esc(i.sheet)}」` : ""}${i.row ? i.row + "行目: " : ""}${esc(i.msg)}</span></li>`).join("")}</ul></details>` : ""}
        <div class="import-mode" role="radiogroup">
          <label><input type="radio" name="imode" value="replace" ${c.mode === "replace" ? "checked" : ""}><span><b>置き換える</b><small>今のデータをすべて、読み込んだ内容に入れ替えます</small></span></label>
          <label><input type="radio" name="imode" value="append" ${c.mode === "append" ? "checked" : ""}><span><b>追加する</b><small>今のデータはそのままに、読み込んだ予定を追加します</small></span></label>
        </div>
        <div class="dialog-foot" style="margin:0 -20px -16px">
          <button class="btn ghost" type="button" data-act="import-back">戻る</button><span class="spacer"></span>
          <button class="btn ghost" type="button" data-close>キャンセル</button>
          <button class="btn primary" type="button" data-act="import-apply" ${r.entries.length ? "" : "disabled"}>取り込む</button>
        </div>`;
      return;
    }
    body.innerHTML = `
      <div class="import-tabs seg-filter" role="tablist">
        <button type="button" data-act="import-view" data-v="file" aria-pressed="${c.view === "file"}">ファイル</button>
        <button type="button" data-act="import-view" data-v="paste" aria-pressed="${c.view === "paste"}">貼り付け</button>
      </div>
      ${c.view === "file" ? `
        <div class="drop-zone" id="importDrop">
          <b>ファイルをここにドラッグ＆ドロップ</b>
          <span style="font-size:12px">Excel（.xlsx / .xls）・CSV・TSV・JSON に対応</span>
          <button class="btn primary" type="button" data-act="choose-file">ファイルを選ぶ</button>
        </div>
        <p class="muted" style="font-size:12px">「時間割」シート（なければ「部屋」「曜日」の列がある最初のシート）を読み込みます。「部屋」「時限」シートがあれば一緒に読み込みます。「期間」シートがあれば、そこに書かれたクォーターごとのシート（2Q・3Q など）を読み込みます。</p>`
      : `
        <p style="margin:0 0 6px;font-size:13px">Excel や Googleスプレッドシートで表を選んでコピーし、下に貼り付けてください。</p>
        <textarea class="paste-area" id="pasteArea" placeholder="部屋&#9;曜日&#9;開始&#9;終了&#9;内容&#9;担当者&#10;101教室&#9;月&#9;9:00&#9;10:30&#9;情報基礎A&#9;山田">${esc(c.text)}</textarea>
        <table class="sample-table"><tr><th>部屋</th><th>曜日</th><th>開始</th><th>終了</th><th>内容</th><th>担当者</th></tr>
          <tr><td>101教室</td><td>月・水</td><td>9:00</td><td>10:30</td><td>情報基礎A</td><td>山田</td></tr>
          <tr><td>202教室</td><td>火</td><td>2限</td><td></td><td>英語</td><td></td></tr></table>
        <p class="muted" style="font-size:12px">見出し行があると列の順番は自由です。「時間」列に「9:00-10:30」「1-2限」とまとめて書いても読み取れます。</p>
        <div class="dialog-foot" style="margin:0 -20px -16px"><span class="spacer"></span>
          <button class="btn ghost" type="button" data-close>キャンセル</button>
          <button class="btn primary" type="button" data-act="import-parse">読み取る</button></div>`}`;
    const dz = $("#importDrop");
    if (dz) {
      dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
      dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    }
  }

  async function importFile(file) {
    try {
      const result = await parseFile(file);
      openImport({ result, label: file.name });
    } catch (e) {
      console.error(e);
      toast(`${file.name} を読み込めませんでした: ${e.message}`, { error: true, ms: 7000 });
    }
  }

  function importText(text, label) {
    try {
      const result = parseText(text, true);
      openImport({ view: "paste", text, result, label: label || "貼り付けたデータ" });
    } catch (e) {
      if (S.importCtx && $("#dlgImport").open) { S.importCtx.text = text; }
      toast("読み取れませんでした: " + e.message, { error: true, ms: 7000 });
    }
  }

  function applyImport() {
    const c = S.importCtx;
    const r = c.result;
    const mode = (document.querySelector('input[name="imode"]:checked') || {}).value || "replace";
    const entries = r.entries.map((e) => K.makeEntry({ ...e, id: null, row: null }));
    const rTerms = (r.terms || []).map((t) => ({ name: t.name, from: t.from, to: t.to }));
    mutate((d) => {
      if (mode === "replace") {
        d.entries = entries;
        d.rooms = K.compileRooms(r.rooms, entries);
        if (r.periods.length) d.periods = r.periods;
        // 期間: 読み込んだ期間に入れ替え。期間名だけの CSV などは今の期間の日付を使い続ける
        d.terms = rTerms.length ? rTerms : entries.some((e) => e.term) ? d.terms || [] : [];
      } else {
        // 期間は名前でまとめる（同じ名前の期間は今の日付のまま）
        d.terms = d.terms || [];
        rTerms.forEach((t) => { if (!d.terms.some((x) => x.name === t.name)) d.terms.push(t); });
        d.entries.push(...entries);
        K.compileRooms(r.rooms, entries).forEach((room) => {
          const ex = d.rooms.find((x) => x.name === room.name);
          if (!ex) d.rooms.push(room);
          else ["building", "capacity", "note"].forEach((k) => { if ((ex[k] === "" || ex[k] == null) && room[k] != null && room[k] !== "") ex[k] = room[k]; });
        });
      }
    }, mode === "replace" ? `${entries.length}件の予定に置き換えました` : `${entries.length}件の予定を追加しました`);
    $("#dlgImport").close();
  }

  /* =========================================================
     画面切り替え・URL
  ========================================================= */
  const TABS = ["now", "timeline", "week", "free", "edit"];

  function hashFor() {
    if (S.tab === "week" && S.room) return "#week/" + encodeURIComponent(S.room);
    return "#" + S.tab;
  }

  function readHash() {
    let h = location.hash.slice(1);
    try { h = decodeURIComponent(h); } catch (e) { /* 手入力などで壊れた % はそのまま使う */ }
    const [tab, ...rest] = h.split("/");
    S.tab = TABS.includes(tab) ? tab : "now";
    if (tab === "week" && rest.length) S.room = rest.join("/");
  }

  function setTab(tab, push = true) {
    if (!TABS.includes(tab)) return;
    if (S.kiosk && tab !== "now") setKiosk(false);
    S.tab = tab;
    const h = hashFor();
    if (location.hash !== h) {
      if (push) history.pushState(null, "", h); else history.replaceState(null, "", h);
    }
    renderAll();
  }

  function gotoRoom(name, dateStr) {
    S.room = name;
    if (dateStr) S.weekDate = K.parseYmd(dateStr) || S.weekDate;
    else if (S.tab === "now" || S.tab === "timeline") S.weekDate = S.date;
    $$("dialog[open]").forEach((d) => d.close());
    setTab("week");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setDate(d) {
    S.date = K.dateOnly(d);
    if (!K.sameDay(S.date, today())) S.live = false;
    renderTab();
  }

  function goLive() {
    S.live = true;
    S.date = today();
    S.min = nowMin();
    S.weekDate = today();
    renderTab();
  }

  function shift(n) {
    if (S.tab === "week") { S.weekDate = K.addDays(S.weekDate, 7 * n); renderTab(); }
    else if (S.tab === "free") { S.free.date = K.addDays(S.free.date, n); renderTab(); }
    else if (S.tab === "now" || S.tab === "timeline") { S.live = false; setDate(K.addDays(S.date, n)); }
  }

  /* ---------- テーマ・大画面 ---------- */
  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    const label = { light: "ライト", dark: "ダーク" }[t] || "自動（端末の設定）";
    $("#btnTheme").title = `テーマ: ${label}（クリックで切替）`;
  }
  function cycleTheme() {
    const cur = document.documentElement.dataset.theme || "auto";
    const next = { auto: "light", light: "dark", dark: "auto" }[cur];
    applyTheme(next);
    try { if (next === "auto") localStorage.removeItem(KEY.theme); else localStorage.setItem(KEY.theme, next); } catch (e) { /* 無視 */ }
    toast("テーマ: " + ({ light: "ライト", dark: "ダーク" }[next] || "自動（端末の設定に合わせる）"));
  }

  function setKiosk(on, fromUser) {
    S.kiosk = on;
    document.body.classList.toggle("kiosk", on);
    if (on) {
      S.tab = "now";
      S.filter = "all";
      goLive();
      if (fromUser && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    renderAll();
  }

  /* =========================================================
     操作（クリック・入力・キーボード・ドラッグ）
  ========================================================= */
  function slotClick(el, ev) {
    if (!S.editMode || ev.target.closest(".blk-entry")) return;
    const rect = el.getBoundingClientRect();
    const t0 = +el.dataset.t0;
    const t1 = +el.dataset.t1;
    const ratio = el.classList.contains("wg-col") ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
    const m = t0 + ratio * (t1 - t0);
    const date = el.dataset.date ? K.parseYmd(el.dataset.date) : S.date;
    const p = S.ds.periods.find((x) => x.start <= m && m < x.end);
    let start = p ? p.start : Math.floor(m / 30) * 30;
    if (!p) {
      // 時限の外をクリックした時は、直前の時限や予定の終わりより前に食い込まないようにする
      const dayList = dayEntries(date).filter((e) => e.room === el.dataset.room);
      [...S.ds.periods, ...dayList].forEach((x) => { if (x.end <= m && x.end > start) start = x.end; });
    }
    const end = p ? p.end : Math.min(start + 90, 1440);
    openForm({ room: el.dataset.room, day: K.dayIndexOf(date), dateHint: date, start, end });
  }

  const ACTIONS = {
    "theme": () => cycleTheme(),
    "kiosk": () => setKiosk(!S.kiosk, true),
    "help": () => openDialog($("#dlgHelp")),
    "reload": () => { S.loading = true; renderNotices(); reload(false); },
    "fav": (el) => {
      const r = el.dataset.room;
      if (S.favorites.has(r)) S.favorites.delete(r); else S.favorites.add(r);
      store.set(KEY.fav, [...S.favorites]);
      renderTab();
    },
    "goto-room": (el) => gotoRoom(el.dataset.room, el.dataset.date),
    "pick-room": (el) => { S.room = el.dataset.room; history.replaceState(null, "", hashFor()); renderTab(); },
    "entry": (el) => openDetail(el.dataset.id),
    "now": () => goLive(),
    "set-date": (el) => { S.live = false; setDate(K.parseYmd(el.dataset.date)); },
    "shift-day": (el) => { S.live = false; setDate(K.addDays(S.date, +el.dataset.n)); },
    "shift-week": (el) => { const n = +el.dataset.n; S.weekDate = n === 0 ? today() : K.addDays(S.weekDate, 7 * n); renderTab(); },
    "filter": (el) => { S.filter = el.dataset.v; renderTab(); },
    "tl-mode": (el) => { S.tlMode = el.dataset.v; savePrefs(); renderTab(); },
    "set-period": (el) => { const p = S.ds.periods[+el.dataset.i]; if (!p) return; S.live = false; S.min = p.start; renderTab(); },
    "slot-period": (el) => {
      if (!S.editMode) return;
      const p = S.ds.periods[+el.dataset.i];
      if (p) openForm({ room: el.dataset.room, day: K.dayIndexOf(S.date), dateHint: S.date, start: p.start, end: p.end });
    },
    "print": () => window.print(),
    "clear-q": () => { S.query = ""; $("#q").value = ""; renderAll(); },
    "goto-issues": () => setTab("edit"),
    "slot": (el, ev) => slotClick(el, ev),
    "free-date": (el) => { S.free.date = K.parseYmd(el.dataset.date); renderTab(); },
    "free-period": (el, ev) => {
      const p = S.ds.periods[+el.dataset.i];
      if (ev.shiftKey && S.free.anchor != null) {
        const a = S.ds.periods[S.free.anchor];
        S.free.from = Math.min(a.start, p.start);
        S.free.to = Math.max(a.end, p.end);
      } else { S.free.from = p.start; S.free.to = p.end; S.free.anchor = +el.dataset.i; }
      renderTab();
    },
    "free-now": () => { const m = Math.floor(nowMin() / 5) * 5; S.free.date = today(); S.free.from = m; S.free.to = Math.min(m + 90, 1440); renderTab(); },
    "add-entry": (el) => openForm({ room: el.dataset.room, day: el.dataset.day != null ? +el.dataset.day : undefined, dateHint: el.dataset.day != null ? K.addDays(K.startOfWeek(S.weekDate), +el.dataset.day) : undefined }),
    "edit-entry": (el) => openForm({ id: el.dataset.id }),
    "dup-entry": (el) => openForm({ copyOf: el.dataset.id }),
    "del-entry": (el) => { $("#dlgDetail").open && $("#dlgDetail").close(); deleteEntries(el.dataset.id.split(",")); },
    "del-selected": () => deleteEntries([...S.selected]),
    "clear-selected": () => { S.selected.clear(); syncSelection(); },
    "edit-more": () => { S.editLimit += EDIT_PAGE * 2; renderTab(); },
    "undo": () => undo(),
    "discard-draft": () => discardDraft(),
    "edit-sub": (el) => { S.editSub = el.dataset.v; renderTab(); },
    "export-xlsx": () => exportData("xlsx"),
    "export-csv": () => exportData("csv"),
    "export-json": () => exportData("json"),
    "export-template": () => exportData("xlsx", true),
    "import-file": () => $("#fileInput").click(),
    "choose-file": () => $("#fileInput").click(),
    "import-paste": () => openImport({ view: "paste" }),
    "import-view": (el) => { S.importCtx.view = el.dataset.v; renderImport(); },
    "import-parse": () => importText($("#pasteArea").value),
    "import-back": () => { S.importCtx.result = null; renderImport(); },
    "import-apply": () => applyImport(),
    "add-room": () => {
      let n = 1;
      while (S.ds.rooms.some((r) => r.name === `新しい部屋${n}`)) n++;
      mutate((d) => { d.rooms.push({ name: `新しい部屋${n}`, building: "", capacity: null, note: "" }); });
      setTimeout(() => { const el = $(`[data-fk="room-${S.ds.rooms.length - 1}-name"]`); if (el) { el.focus(); el.select(); } }, 0);
    },
    "move-room": (el) => {
      const i = +el.dataset.i;
      const j = i + +el.dataset.n;
      mutate((d) => { if (j >= 0 && j < d.rooms.length) [d.rooms[i], d.rooms[j]] = [d.rooms[j], d.rooms[i]]; });
    },
    "del-room": (el) => {
      const room = S.ds.rooms[+el.dataset.i];
      if (!room) return;
      const n = S.ds.entries.filter((e) => e.room === room.name).length;
      mutate((d) => {
        d.rooms = d.rooms.filter((r) => r.name !== room.name);
        d.entries = d.entries.filter((e) => e.room !== room.name);
      }, `「${room.name}」${n ? `と予定${n}件` : ""}を削除しました`);
    },
    "add-period": () => {
      const ps = S.ds.periods;
      const last = ps[ps.length - 1];
      const start = last ? last.end + 10 : 540;
      mutate((d) => { d.periods.push({ name: `${ps.length + 1}限`, start, end: Math.min(start + 90, 1440) }); });
    },
    "del-period": (el) => {
      const i = +el.dataset.i;
      mutate((d) => { d.periods.splice(i, 1); }, "時限を削除しました");
    },
  };

  function onClick(ev) {
    const closer = ev.target.closest("[data-close]");
    if (closer) { const d = closer.closest("dialog"); if (d) d.close(); return; }
    const tabBtn = ev.target.closest(".tab-btn");
    if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
    const el = ev.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) fn(el, ev);
  }

  function onInput(ev) {
    const el = ev.target;
    const bind = el.dataset && el.dataset.bind;
    if (el.id === "q") {
      if (ev.type === "change") return;
      S.query = el.value;
      renderSearchResults();
      renderTab();
      return;
    }
    if (!bind) return;
    const isChange = ev.type === "change";
    // select・チェックボックスは change のみ、文字入力は input のみで処理する
    const changeOnly = el.tagName === "SELECT" || el.type === "checkbox";
    if (changeOnly && !isChange) return;
    if (!changeOnly && isChange && /^(free-from|free-to|free-cap|edit-q)$/.test(bind)) return;
    switch (bind) {
      case "date":
        if (!isChange) return;
        if (K.parseYmd(el.value)) { S.live = false; setDate(K.parseYmd(el.value)); }
        break;
      case "time": {
        if (!isChange) return;
        const m = K.parseTime(el.value);
        if (m !== null) { S.live = false; S.min = m; renderTab(); }
        break;
      }
      case "building": S.building = el.value; savePrefs(); renderTab(); break;
      case "sort": S.sort = el.value; savePrefs(); renderTab(); break;
      case "free-date": if (isChange && K.parseYmd(el.value)) { S.free.date = K.parseYmd(el.value); renderTab(); } break;
      case "free-from": case "free-to": {
        const m = K.parseTime(el.value);
        if (m === null) return;
        S.free[bind === "free-from" ? "from" : "to"] = m;
        syncPeriodChips();
        renderFreeResults();
        break;
      }
      case "free-cap": S.free.cap = el.value; renderFreeResults(); break;
      case "edit-q": S.editQuery = el.value; S.editLimit = EDIT_PAGE; renderTab(); break;
      case "edit-sort": S.editSort = el.value; S.editLimit = EDIT_PAGE; renderTab(); break;
      case "room-select": S.room = el.value; history.replaceState(null, "", hashFor()); renderTab(); break;
      case "edit-mode":
        S.editMode = el.checked;
        renderAll();
        toast(S.editMode ? "編集モード: 時間割の空いている所をクリックすると予定を追加できます" : "編集モードを終了しました");
        break;
      case "sel":
        if (el.checked) S.selected.add(el.dataset.id); else S.selected.delete(el.dataset.id);
        syncSelection();
        break;
      case "sel-all":
        editList().forEach((e) => { if (el.checked) S.selected.add(e.id); else S.selected.delete(e.id); });
        syncSelection();
        break;
      case "room-field": {
        if (!isChange) return;
        const i = +el.dataset.i;
        const f = el.dataset.f;
        const room = S.ds.rooms[i];
        if (!room) return;
        if (f === "name") {
          const to = K.nfkc(el.value);
          if (!to) { el.value = room.name; toast("部屋名は空にできません", { error: true }); return; }
          if (to === room.name) return;
          if (S.ds.rooms.some((r) => r.name === to)) { el.value = room.name; toast(`「${to}」はすでにあります`, { error: true }); return; }
          mutate((d) => { const r = d.rooms.find((x) => x.name === room.name); if (r) r.name = to; renameRoom(d, room.name, to); }, `部屋名を「${to}」に変更しました`);
        } else {
          let val = el.value.trim();
          if (f === "capacity") val = val === "" ? null : Math.max(0, Math.round(Number(val)));
          if (f === "capacity" && val !== null && !isFinite(val)) return;
          mutate((d) => { const r = d.rooms.find((x) => x.name === room.name); if (r) r[f] = val; });
        }
        break;
      }
      case "period-field": {
        if (!isChange) return;
        const i = +el.dataset.i;
        const f = el.dataset.f;
        const val = f === "name" ? el.value.trim() : K.parseTime(el.value);
        if (val === null || val === "") return;
        mutate((d) => {
          const p = d.periods[i];
          if (!p) return;
          p[f] = val;
          if (p.end <= p.start) p.end = Math.min(p.start + 90, 1440);
          d.periods.sort((a, b) => a.start - b.start);
        });
        break;
      }
      default: break;
    }
  }

  function isTyping(el) {
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  function onKey(e) {
    if (e.key === "Escape" && e.target.id === "q" && S.query) { ACTIONS["clear-q"](); return; }
    // タブにフォーカスがある時は ← → Home End でタブを移動
    if (e.target.classList && e.target.classList.contains("tab-btn") && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) {
      e.preventDefault();
      const i = TABS.indexOf(e.target.dataset.tab);
      const n = { ArrowLeft: (i + TABS.length - 1) % TABS.length, ArrowRight: (i + 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
      setTab(TABS[n]);
      $(`.tab-btn[data-tab="${TABS[n]}"]`).focus();
      return;
    }
    if (isTyping(e.target) || document.querySelector("dialog[open]")) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      if (S.undo.length) { e.preventDefault(); undo(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k >= "1" && k <= "5") { setTab(TABS[+k - 1]); return; }
    switch (k) {
      case "/": e.preventDefault(); $("#q").focus(); break;
      case "ArrowLeft": shift(-1); break;
      case "ArrowRight": shift(1); break;
      case "t": case "T": goLive(); break;
      case "n": case "N": openForm({}); break;
      case "f": case "F": setKiosk(!S.kiosk, true); break;
      case "?": openDialog($("#dlgHelp")); break;
      case "Escape": if (S.kiosk) setKiosk(false); break;
      default: break;
    }
  }

  function setupDragDrop() {
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth++; document.body.classList.add("dragging"); });
    window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove("dragging"); });
    window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove("dragging");
      const file = e.dataTransfer.files[0];
      if (file) importFile(file);
    });
    $("#fileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) importFile(file);
    });
    // データ編集画面で表をそのまま Ctrl+V すると取り込み画面を開く
    document.addEventListener("paste", (e) => {
      if (S.tab !== "edit" || isTyping(e.target) || document.querySelector("dialog[open]")) return;
      const text = e.clipboardData && e.clipboardData.getData("text");
      if (text && /\t|,|\n/.test(text)) { e.preventDefault(); importText(text); }
    });
  }

  /* =========================================================
     時計・自動更新
  ========================================================= */
  function tick() {
    const d = new Date();
    $("#clockTime").textContent = `${K.pad2(d.getHours())}:${K.pad2(d.getMinutes())}:${K.pad2(d.getSeconds())}`;
    $("#clockDate").textContent = `${d.getFullYear()}.${K.pad2(d.getMonth() + 1)}.${K.pad2(d.getDate())} (${K.DAYS[K.dayIndexOf(d)]})`;
    const m = d.getHours() * 60 + d.getMinutes();
    if (m === S.lastMinute) return;
    S.lastMinute = m;
    if (S.live) { S.date = K.dateOnly(d); S.min = m; }
    if (!S.ds || document.querySelector("dialog[open]")) return;
    if (S.tab === "now" || S.tab === "timeline" || S.tab === "week") renderTab();
  }

  function setupAutoReload() {
    const min = Number(CFG.autoReloadMinutes) || 0;
    if (min <= 0 || location.protocol === "file:") return;
    setInterval(() => { if (!document.hidden) reload(true); }, min * 60000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      tick();
      if (S.published && Date.now() - S.published.loadedAt > min * 60000) reload(true);
    });
  }

  /* =========================================================
     初期化
  ========================================================= */
  function init() {
    document.title = CFG.title;
    $("#brandTitle").textContent = CFG.title;
    $("#brandEyebrow").textContent = CFG.eyebrow;
    applyTheme(document.documentElement.dataset.theme);

    S.draft = loadDraft();
    refreshDataset();
    readHash();

    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onInput);
    document.addEventListener("keydown", onKey);
    window.addEventListener("popstate", () => { readHash(); renderAll(); });
    // 背景クリックで閉じる（入力欄から外へドラッグしただけの時は閉じない）
    $$("dialog").forEach((d) => {
      let downOnBackdrop = false;
      d.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === d; });
      d.addEventListener("click", (e) => { if (e.target === d && downOnBackdrop) d.close(); downOnBackdrop = false; });
    });
    $("#dlgImport").addEventListener("drop", (e) => { const dz = $("#importDrop"); if (dz) dz.classList.remove("over"); });
    setupForm();
    setupDragDrop();

    tick();
    setInterval(tick, 1000);
    renderAll();
    if (PARAMS.get("kiosk") === "1") setKiosk(true);
    reload(false).then(() => {
      if (S.draft && S.published && S.draft.baseSig && S.draft.baseSig !== S.published.sig) {
        toast("編集を始めた後に公開データが更新されています", { ms: 6000 });
      }
    });
    setupAutoReload();
  }

  init();
})();
