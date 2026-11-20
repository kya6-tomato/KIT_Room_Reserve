// 実行: node tests/core.test.js
const assert = require("assert");
const K = require("../assets/core.js");
let n = 0;
const t = (name, fn) => { fn(); n++; };
const P = [{name:"1限",start:540,end:630},{name:"2限",start:640,end:730},{name:"3限",start:780,end:870}];

t("parseTime", () => {
  const c = {"9:00":540,"09:00:00":540,"9時":540,"9時半":570,"9時30分":570,"午後1時":780,"1:30 PM":810,"0930":570,"９：００":540,"24:00":1440,"13.30":810};
  for (const [k,v] of Object.entries(c)) assert.strictEqual(K.parseTime(k), v, k);
  assert.strictEqual(K.parseTime(0.375), 540);
  assert.strictEqual(K.parseTime(9), 540);
  assert.strictEqual(K.parseTime(930), 570);
  assert.strictEqual(K.parseTime(45000.5), 720);
  for (const bad of ["abc","25:00","9:75","",null]) assert.strictEqual(K.parseTime(bad), null, String(bad));
});
t("parseTimeRange", () => {
  assert.deepStrictEqual(K.parseTimeRange("9:00-10:30"), {start:540,end:630});
  assert.deepStrictEqual(K.parseTimeRange("9時〜10時半"), {start:540,end:630});
  assert.deepStrictEqual(K.parseTimeRange("13:00～14:30"), {start:780,end:870});
  assert.strictEqual(K.parseTimeRange("9:00"), null);
});
t("parsePeriodRef", () => {
  assert.deepStrictEqual(K.parsePeriodRef("2限", P), {start:640,end:730});
  assert.deepStrictEqual(K.parsePeriodRef("1-2限", P), {start:540,end:730});
  assert.deepStrictEqual(K.parsePeriodRef("第3時限", P), {start:780,end:870});
  assert.deepStrictEqual(K.parsePeriodRef(1, P), {start:540,end:630});
  assert.strictEqual(K.parsePeriodRef("7限", P), null);
  assert.strictEqual(K.parsePeriodRef("9:00", P), null);
});
t("parseDays", () => {
  assert.deepStrictEqual(K.parseDays("月"), [0]);
  assert.deepStrictEqual(K.parseDays("火曜日"), [1]);
  assert.deepStrictEqual(K.parseDays("Wed"), [2]);
  assert.deepStrictEqual(K.parseDays("月・水・金"), [0,2,4]);
  assert.deepStrictEqual(K.parseDays("月〜金"), [0,1,2,3,4]);
  assert.deepStrictEqual(K.parseDays("平日"), [0,1,2,3,4]);
  assert.deepStrictEqual(K.parseDays("土日"), [5,6]);
  assert.deepStrictEqual(K.parseDays("金~月"), [0,4,5,6]);
  assert.deepStrictEqual(K.parseDays("Monday, Thursday"), [0,3]);
  assert.strictEqual(K.parseDays("月x"), null);
});
t("parseDate", () => {
  assert.strictEqual(K.parseDate("2026/12/1"), "2026-12-01");
  assert.strictEqual(K.parseDate("2026年12月1日"), "2026-12-01");
  assert.strictEqual(K.parseDate("12/1", 2026), "2026-12-01");
  assert.strictEqual(K.parseDate(46357), "2026-12-01");
  assert.strictEqual(K.parseDate("2026/2/30"), null);
});
t("parseSchedule: 色々な書き方", () => {
  const aoa = [
    ["時間割（タイトル行）"],
    ["教室", "曜日", "時間", "授業名", "担当", "メモ"],
    ["１０１教室", "月・水", "9:00-10:30", "情報基礎", "山田", ""],
    ["101教室", "火", "2限", "英語", "", ""],
    ["", "火", "2限", "部屋なし", "", ""],
    ["202", "謎", "1限", "x", "", ""],
    ["202", "木", "10:30-9:00", "逆", "", ""],
    [],
    ["202", "金", "あいう", "x", "", ""],
  ];
  const r = K.parseSchedule(aoa, {periods:P});
  assert.strictEqual(r.entries.length, 3);
  assert.strictEqual(r.entries[0].room, "101教室");
  assert.deepStrictEqual(r.entries.map(e=>e.day), [0,2,1]);
  assert.strictEqual(r.entries[2].start, 640);
  assert.deepStrictEqual(r.issues.map(i=>i.row), [5,6,7,9]);
});
t("parseSchedule: 日付・休講", () => {
  const aoa = [["部屋","曜日","日付","開始","終了","内容"],
    ["A","月","","9:00","10:30","授業"],
    ["A","","2026/11/23","9:00","10:30","休講"],
    ["A","火","2026/11/23","13:00","14:00","臨時"]];
  const r = K.parseSchedule(aoa, {});
  assert.strictEqual(r.entries.length, 3);
  assert.strictEqual(r.issues.length, 1); // 曜日と日付の不一致
  const mon = new Date(2026,10,23), mon2 = new Date(2026,10,30);
  assert.deepStrictEqual(K.entriesOn(r.entries, mon).map(e=>e.title), ["臨時"]);
  assert.deepStrictEqual(K.entriesOn(r.entries, mon, {withCancelled:true}).map(e=>e.title+(e.cancelled?"x":"")), ["授業x","臨時"]);
  assert.deepStrictEqual(K.entriesOn(r.entries, mon2).map(e=>e.title), ["授業"]);
});
t("status / free / conflicts / lanes", () => {
  const E = [{id:1,room:"A",day:0,start:540,end:630,title:"a"},{id:2,room:"A",day:0,start:630,end:700,title:"b"},{id:3,room:"A",day:0,start:780,end:870,title:"c"},{id:4,room:"A",day:0,start:800,end:900,title:"d"}];
  const s = K.roomStatus(E, "A", 600);
  assert.strictEqual(s.state, "busy"); assert.strictEqual(s.busyUntil, 700); assert.strictEqual(s.next.title, "b");
  assert.strictEqual(K.roomStatus(E, "A", 770, 15).state, "soon");
  assert.strictEqual(K.roomStatus(E, "A", 720, 15).state, "free");
  assert.strictEqual(K.roomStatus(E, "A", 720, 15).freeUntil, 780);
  assert.deepStrictEqual(K.freeIntervals(E, "A", 500, 800), [[500,540],[700,780]]);
  assert.strictEqual(K.findConflicts(E).length, 1);
  const L = K.assignLanes(E);
  assert.deepStrictEqual([...L.values()].map(v=>[v.lane,v.lanes]), [[0,1],[0,1],[0,2],[1,2]]);
});
t("CSV / JSON 往復", () => {
  const aoa = K.parseDelimited('部屋,曜日,開始,終了,内容\n"A,1",月,9:00,10:30,"say ""hi"""\r\nB,火,13:00,14:30,x\n');
  assert.deepStrictEqual(aoa[1], ["A,1","月","9:00","10:30",'say "hi"']);
  const tsv = K.parseDelimited("部屋\t曜日\t開始\t終了\nA\t月\t9:00\t10:00");
  assert.strictEqual(tsv[1][0], "A");
  const r = K.parseTables({schedule:{aoa, offset:0}}, {});
  const json = K.toJSON(r.entries, K.compileRooms([], r.entries), P);
  const back = K.parseTables(K.jsonToTables(JSON.parse(JSON.stringify(json))), {});
  assert.strictEqual(back.entries.length, 2);
  assert.strictEqual(back.entries[0].title, 'say "hi"');
  assert.strictEqual(back.periods.length, 3);
  assert.strictEqual(back.rooms.length, 2);
  const csv = K.toCSV(K.toScheduleAoa(r.entries, ["B","A,1"]));
  assert.ok(csv.startsWith("\uFEFF部屋,曜日,日付"));
  assert.ok(csv.split("\r\n")[1].startsWith("B,"));
});
t("時限列の 1-2 は時限、開始1・終了2も時限", () => {
  const r = K.parseSchedule([["部屋","曜日","時限"],["A","月","1-2"]], {periods:P});
  assert.deepStrictEqual([r.entries[0].start, r.entries[0].end], [540, 730]);
  const r2 = K.parseSchedule([["部屋","曜日","開始","終了"],["A","月","1","2"],["A","火","9","10"]], {periods:P});
  assert.deepStrictEqual(r2.entries.map(e=>[e.start,e.end]), [[540,730],[540,600]]);
});
t("番号のない時限があっても番号がずれない", () => {
  const P2 = [...P.slice(0,2), {name:"昼休み",start:730,end:780}, {name:"3限",start:780,end:870}];
  assert.deepStrictEqual(K.parsePeriodRef("3", P2), {start:780,end:870});
  assert.deepStrictEqual(K.parsePeriodRef("昼休み", P2), {start:730,end:780});
});
t("Excel の 24:00（数値の1）", () => {
  const r = K.parseSchedule([["部屋","曜日","開始","終了"],["A","月",22/24,1]], {});
  assert.deepStrictEqual([r.entries[0].start, r.entries[0].end], [1320, 1440]);
});
t("閉じない引用符で後ろの行が消えない / タイトル行つき貼り付け", () => {
  const aoa = K.parseDelimited('部屋\t曜日\t開始\t終了\t担当者\nA\t月\t9:00\t10:00\t"同上\nB\t火\t9:00\t10:00\tx\nC\t水\t9:00\t10:00\ty');
  assert.strictEqual(aoa.length, 4);
  assert.strictEqual(aoa[1][4], '"同上');
  const t2 = K.parseDelimited("2026年度 前期\n\n部屋\t曜日\t開始\t終了\nA\t月\t9:00\t10:00");
  assert.strictEqual(K.parseSchedule(t2, {}).entries.length, 1);
});
t("休講の枠に入れた代わりの予定は重複扱いしない", () => {
  const E = [
    {id:"w",room:"A",day:4,date:null,start:540,end:630,title:"授業"},
    {id:"c",room:"A",day:4,date:"2026-11-20",start:540,end:630,title:"休講"},
    {id:"x",room:"A",day:4,date:"2026-11-20",start:540,end:630,title:"説明会"},
    {id:"y",room:"A",day:4,date:"2026-11-27",start:600,end:660,title:"別の日"},
  ];
  assert.deepStrictEqual(K.findConflicts(E).map(([a,b])=>a.id+b.id), ["wy"]);
  assert.strictEqual(K.overlapsWith(E, {room:"A",day:4,date:"2026-11-20",start:540,end:600}).map(e=>e.id).join(), "x");
});
t("英字の短い列名は前方一致しない（Topic が to にならない）", () => {
  const m = K.mapHeader(["部屋","曜日","開始","終了","Topic"], K.SCHEDULE_FIELDS);
  assert.strictEqual(m.end, 3);
  assert.ok(!Object.values(m).includes(4) || m.title === 4);
});
t("連続コマのまとめ（休み10分はまとめる・昼休みはまとめない）", () => {
  const KP = [[530,620],[630,720],[780,870],[880,970]];
  const E = KP.map(([s,e],i) => ({id:"p"+i,room:"A",day:0,date:null,start:s,end:e,title:"実験",owner:"X"}));
  E.push({id:"o",room:"A",day:0,date:null,start:880,end:970,title:"別",owner:"Y"});
  const list = K.entriesOn(E, new Date(2026,10,23));
  assert.deepStrictEqual(list.map(e=>[e.title,e.start,e.end,e.partIds.length]), [["実験",530,720,2],["実験",780,970,2],["別",880,970,1]]);
  assert.strictEqual(K.entriesOn(E, new Date(2026,10,23), {merge:false}).length, 5);
  assert.strictEqual(K.roomStatus(list, "A", 725).state, "free"); // 2限と3限の間（昼休み）は空き
  assert.strictEqual(K.roomStatus(list, "A", 625).state, "busy"); // 1限と2限の間の休み時間は使用中のまま
});

/* ---------- 期間（クォーター） ---------- */
const termBook = () => ({
  terms: {name:"期間", offset:0, aoa:[["シート","開始日","終了日"],["3Q","2026/10/01","2026/11/30"],["4Q",46357,"2027/2/10"],["5Q","2027/4/1","2027/5/31"]]},
  sheets: {
    "3Q": {name:"3Q", offset:0, aoa:[["部屋","曜日","時限","内容","担当者"],["1101","月",1,"情報A","山田"],["1101","火",2,"英語","",],["1101","謎",1,"x",""]]},
    "４Ｑ": {name:"４Ｑ", offset:0, aoa:[["部屋","曜日","日付","時限","内容"],["1101","月","",1,"数学B"],["1101","","2027/03/01",1,""]]},
  },
  schedule: {name:"時間割", offset:0, aoa:[["部屋","曜日","開始","終了","内容"],["1101","水","9:00","10:00","共通ゼミ"]]},
});
t("期間シート: 列名の読み分け（開始日・終了日と開始・終了）", () => {
  const r = K.parseTermTable([["期間","期間開始","期間終了"],["2Q","2026-06-10","2026/8/5"],["bad","x",""],["逆","2026/9/2","2026/9/1"]], {sheet:"期間"});
  assert.deepStrictEqual(r.terms, [{name:"2Q",from:"2026-06-10",to:"2026-08-05"}]);
  assert.strictEqual(r.issues.length, 2);
  assert.ok(r.issues.every(i => i.sheet === "期間"));
  // 時間割の列名「開始」「終了」だけの表は期間の表とみなさない
  assert.strictEqual(K.parseTermTable([["シート","開始","終了"],["2Q","2026/6/1","2026/8/1"]]).terms.length, 0);
});
t("期間シート: 各シートを読んで期間を付ける", () => {
  const r = K.parseTables(termBook(), {defaultPeriods:P});
  assert.deepStrictEqual(r.terms, [{name:"3Q",from:"2026-10-01",to:"2026-11-30"},{name:"４Ｑ",from:"2026-12-01",to:"2027-02-10"}]);
  assert.strictEqual(r.entries.length, 5); // 3Q 2件 + 4Q 2件 + 共通 1件
  const by = (t) => r.entries.filter(e => e.term === t).map(e => e.title);
  assert.deepStrictEqual(by("3Q"), ["情報A","英語"]);
  assert.deepStrictEqual(by("４Ｑ"), ["数学B",""]);
  assert.deepStrictEqual(by(null), ["共通ゼミ"]);
  assert.strictEqual(r.entries[0].termFrom, "2026-10-01");
  assert.strictEqual(r.entries[0].termTo, "2026-11-30");
  // 読めない行・期間外の日付・見つからないシートは、どのシートかが分かる
  const msg = r.issues.map(i => `${i.sheet}:${i.row||""}:${i.level}`);
  assert.ok(msg.includes("3Q:4:error"), msg.join());
  assert.ok(msg.includes("４Ｑ:3:warn"), msg.join()); // 2027/03/01 は 4Q の外
  assert.ok(r.issues.some(i => i.sheet === "期間" && /5Q/.test(i.msg)));
  // 期間シートがない時は今まで通り
  const plain = K.parseTables({schedule: termBook().schedule}, {});
  assert.deepStrictEqual(plain.terms, []);
  assert.strictEqual(plain.entries[0].term, null);
});
t("期間: entriesOn は期間の境目で切り替わる", () => {
  const r = K.parseTables(termBook(), {defaultPeriods:P});
  const titles = (y,m,d) => K.entriesOn(r.entries, new Date(y,m-1,d)).map(e => e.title);
  assert.deepStrictEqual(titles(2026,11,30), ["情報A"]);   // 3Q 最終日（月）
  assert.deepStrictEqual(titles(2026,12,7), ["数学B"]);    // 4Q（月）
  assert.deepStrictEqual(titles(2026,9,28), []);           // どの期間でもない月曜
  assert.deepStrictEqual(titles(2026,9,30), ["共通ゼミ"]); // 期間のない予定はいつでも
  assert.strictEqual(K.termFor(r.terms, new Date(2026,11,1)).name, "４Ｑ");
  assert.strictEqual(K.termFor(r.terms, "2026-09-30"), null);
  const c = K.termContext(r.terms, "2026-09-30");
  assert.strictEqual(c.next.name, "3Q"); assert.strictEqual(c.prev, null);
  assert.strictEqual(K.termLabel(r.terms[0]), "3Q（10/1〜11/30）");
});
t("期間: 期間が重ならない予定は重複扱いしない", () => {
  const a = {id:"a",room:"A",day:0,date:null,start:540,end:630,title:"3Q",term:"3Q",termFrom:"2026-10-01",termTo:"2026-11-30"};
  const b = {id:"b",room:"A",day:0,date:null,start:540,end:630,title:"4Q",term:"4Q",termFrom:"2026-12-01",termTo:"2027-02-10"};
  const c = {id:"c",room:"A",day:0,date:null,start:600,end:660,title:"共通"};
  const d = {id:"d",room:"A",day:0,date:"2026-12-07",start:540,end:600,title:"臨時"};
  assert.deepStrictEqual(K.findConflicts([a,b]).length, 0);
  assert.deepStrictEqual(K.findConflicts([a,b,c]).map(([x,y]) => x.id+y.id), ["ac","bc"]);
  assert.deepStrictEqual(K.findConflicts([a,b,d]).map(([x,y]) => x.id+y.id), ["bd"]); // 12/7 は 4Q だけ
  assert.deepStrictEqual(K.overlapsWith([a,b], {room:"A",day:0,date:null,start:540,end:600,termFrom:"2026-10-01",termTo:"2026-11-30"}).map(e => e.id), ["a"]);
});
t("期間: JSON・CSV の往復", () => {
  const r = K.parseTables(termBook(), {defaultPeriods:P});
  const json = JSON.parse(JSON.stringify(K.toJSON(r.entries, K.compileRooms([], r.entries), P, r.terms)));
  assert.strictEqual(json.terms.length, 2);
  const back = K.parseTables(K.jsonToTables(json), {});
  assert.deepStrictEqual(back.terms, r.terms);
  const q4 = back.entries.find(e => e.title === "数学B");
  assert.deepStrictEqual([q4.term, q4.termFrom, q4.termTo], ["４Ｑ","2026-12-01","2027-02-10"]);
  assert.strictEqual(back.entries.find(e => e.title === "共通ゼミ").term, null);
  // 期間のないデータの JSON には term が付かない
  assert.ok(!("terms" in K.toJSON([], [], [])));
  // CSV は期間名だけ（日付は付かない）
  const csv = K.toScheduleAoa(r.entries, [], {term:true});
  assert.strictEqual(csv[0][8], "期間");
  const fromCsv = K.parseTables({schedule:{aoa:K.parseDelimited(K.toCSV(csv)), offset:0}}, {});
  assert.strictEqual(fromCsv.entries.find(e => e.title === "情報A").term, "3Q");
  assert.strictEqual(fromCsv.entries.find(e => e.title === "情報A").termFrom, null);
  // 期間の一覧を当てはめると日付が付く
  K.applyTerms(fromCsv.entries, r.terms);
  assert.strictEqual(fromCsv.entries.find(e => e.title === "情報A").termTo, "2026-11-30");
  assert.deepStrictEqual(K.toTermsAoa(r.terms)[1], ["3Q","2026/10/01","2026/11/30"]);
});
t("期間: parseWorkbook（SheetJS の代わりに簡単な偽物を使う）", () => {
  const fakeX = {utils:{decode_range:() => ({s:{r:0}}), sheet_to_json:(ws) => ws.aoa}};
  const book = (sheets) => ({SheetNames:Object.keys(sheets), Sheets:Object.fromEntries(Object.entries(sheets).map(([k,aoa]) => [k, {"!ref":"A1", aoa}]))});
  const tb = termBook();
  const wb = book({"期間":tb.terms.aoa, "3Q":tb.sheets["3Q"].aoa, "4Q":tb.sheets["４Ｑ"].aoa, "部屋":[["部屋","定員"],["1101",40]]});
  const r = K.parseWorkbook(wb, fakeX, {defaultPeriods:P});
  assert.deepStrictEqual(r.terms.map(x => x.name), ["3Q","4Q"]); // 期間シートの「４Ｑ」は実際のシート名「4Q」になる
  assert.strictEqual(r.entries.length, 4);
  assert.strictEqual(r.rooms[0].capacity, 40);
  // 期間シートはあるが、書かれたシートが1つもない → 今まで通り時間割を読む＋注意
  const r2 = K.parseWorkbook(book({"時間割":tb.schedule.aoa, "期間":[["シート","開始日","終了日"],["9Q","2026/1/1","2026/2/1"]]}), fakeX, {});
  assert.deepStrictEqual(r2.terms, []);
  assert.strictEqual(r2.entries.length, 1);
  assert.ok(r2.issues.some(i => i.sheet === "期間" && i.level === "warn"));
  // 期間シートがなければ今まで通り
  const r3 = K.parseWorkbook(book({"時間割":tb.schedule.aoa}), fakeX, {});
  assert.deepStrictEqual([r3.entries.length, r3.terms.length, r3.issues.length], [1, 0, 0]);
});
console.log(`OK: ${n} テストすべて成功`);
