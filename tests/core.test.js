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
console.log(`OK: ${n} テストすべて成功`);
