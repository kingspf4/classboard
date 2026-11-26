/**
 * 作業繳交看板＋聯絡簿 — Firebase 資料層
 *
 * 取代原本 Apps Script 的 Code.gs：所有讀寫都直接在瀏覽器對 Firebase Realtime Database 進行，
 * 畫面用「即時監聽」更新，不再每 3 秒詢問一次。
 *
 * 資料庫結構（全部在 /c 底下）：
 *   settings            班級名稱、人數、週次起算日、大螢幕模式、公告、隱私模式
 *   blocks/{id}         聯絡簿區塊：name、type（科目／提醒）、color、show、size、quick（常用項目）、order
 *   layout              座位表：二維陣列，0 代表走道或空位
 *   days/{日期}          特殊日：停課／補課／上課（只記例外）
 *   records/{日期}/{id}  繳交卡片：title、order、src（來源聯絡簿項目）、seats/{座號}: 狀態（未交不存）
 *   leave/{日期}/{座號}   請假
 *   items/{日期}/{id}    聯絡簿項目：block、text、grade、order
 *   links/{項目id}       聯絡簿項目已建立成哪一天的哪張卡片：{due, aid}
 *   tool、picked、meta   倒數／抽籤狀態、今天抽過的人、最後一次更新訊息
 */

var STATUS_LIST = ['未交', '已交', '待訂正', '已訂正'];
var DAY_TYPES = ['上課', '停課', '補課'];
var DATA_EXAM_RE = /考|測驗/;
var DATA_NO_GRADE_RE = /考|測驗|背|預習|複習/;
var BLOCK_PALETTE = ['#B45309', '#047857', '#BE185D', '#0369A1', '#6D28D9', '#9F1239'];

var DEFAULT_SETTINGS = {
  className: '六年仁班',
  size: 30,
  weekStart: '2026-08-31',
  displayMode: '作業看板',
  privacy: false,
  announce: ''
};
var DEFAULT_BLOCKS = [
  { name: '國語', type: '科目', color: '#C2410C', quick: ['習作', '生字', '圈詞', '甲本', '乙本'] },
  { name: '數學', type: '科目', color: '#2453C2', quick: ['數習', '課本', '數學練習'] },
  { name: '英語', type: '科目', color: '#0F766E', quick: ['單字', '習作', '背誦課文'] },
  { name: '閱讀桃花源', type: '科目', color: '#7C3AED', quick: ['閱讀提問單'] },
  { name: '攜帶物品・提醒', type: '提醒', color: '#4A505C', quick: ['帶美勞用具', '繳交家長回條'] }
];

var DB = null;
var ROOT = 'c';
var cache = {};          // 全域資料：settings、blocks、layout、days、tool、picked、meta、links
var dayCache = {};       // 某一天的資料：'records|日期'、'leave|日期'、'items|日期'
var globalLoaded = {};
var dayListeners = [];   // 目前監聽中的「某一天」路徑
var attachedFor = '';    // 目前監聽的是哪一天（與前一個上課日）
var syncing = {};        // 避免同一天同時建立兩次卡片
var onDataChange = function () {};
var onDenied = function () {};

function dref(p) { return DB.ref(ROOT + (p ? '/' + p : '')); }
function dpad(n) { return (n < 10 ? '0' : '') + n; }
function dfmt(d) { return d.getFullYear() + '-' + dpad(d.getMonth() + 1) + '-' + dpad(d.getDate()); }
function dparse(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function checkDate(s) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new Error('日期格式錯誤：' + s); }
function cleanText(t, max) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, max || 100); }
function serverNow() { return Date.now() + clockSkew; }
var clockSkew = 0;

/* ---------- 啟動與監聽 ---------- */

/** 登入成功後呼叫：第一次使用就寫入預設資料，再開始監聽 */
function startData(db, changed, denied) {
  DB = db; onDataChange = changed; onDenied = denied;
  DB.ref('.info/serverTimeOffset').on('value', function (s) { clockSkew = s.val() || 0; });
  return dref('settings').once('value').then(function (s) {
    if (s.val()) return null;
    var up = { settings: DEFAULT_SETTINGS, layout: defaultLayout(DEFAULT_SETTINGS.size) };
    DEFAULT_BLOCKS.forEach(function (b, i) {
      up['blocks/b' + i] = { name: b.name, type: b.type, color: b.color, show: true, size: '自動', quick: b.quick, order: i };
    });
    return dref().update(up);
  }).then(function () {
    ['settings', 'blocks', 'layout', 'days', 'tool', 'picked', 'meta', 'links'].forEach(function (k) {
      dref(k).on('value', function (s) {
        cache[k] = s.val();
        globalLoaded[k] = true;
        onDataChange();
      }, function (err) { onDenied(err); });
    });
  });
}

function connectedRef() { return DB.ref('.info/connected'); }

/** 切換日期時，改為監聽那一天、以及它前一個上課日的聯絡簿 */
function watchDay(date) {
  var prev = prevSchoolDay(date);
  var key = date + '|' + prev;
  if (key === attachedFor) return;
  attachedFor = key;
  dayListeners.forEach(function (l) { l.ref.off('value', l.fn); });
  dayListeners = [];
  var paths = ['records|' + date, 'leave|' + date, 'items|' + date];
  if (prev) paths.push('items|' + prev);
  paths.forEach(function (p) {
    var parts = p.split('|');
    var r = dref(parts[0] + '/' + parts[1]);
    var fn = r.on('value', function (s) { dayCache[p] = s.val() || {}; onDataChange(); }, function (err) { onDenied(err); });
    dayListeners.push({ ref: r, fn: fn });
  });
}

function ready(date) {
  var keys = ['settings', 'blocks', 'layout', 'days', 'tool', 'picked', 'meta', 'links'];
  for (var i = 0; i < keys.length; i++) if (!globalLoaded[keys[i]]) return false;
  var prev = prevSchoolDay(date);
  return ('records|' + date) in dayCache && ('leave|' + date) in dayCache && ('items|' + date) in dayCache &&
    (!prev || ('items|' + prev) in dayCache);
}

/* ---------- 由快取組出畫面需要的資料 ---------- */

function settings() {
  var s = cache.settings || {};
  var size = parseInt(s.size, 10);
  return {
    className: s.className || '',
    size: size >= 1 && size <= 60 ? size : 30,
    weekStart: /^\d{4}-\d{2}-\d{2}$/.test(s.weekStart || '') ? s.weekStart : '',
    displayMode: s.displayMode === '聯絡簿' ? '聯絡簿' : '作業看板',
    privacy: !!s.privacy,
    announce: s.announce || ''
  };
}

function blockList() {
  var b = cache.blocks || {};
  return Object.keys(b).map(function (id) {
    var x = b[id] || {};
    return {
      id: id,
      name: x.name || '',
      type: x.type === '提醒' ? '提醒' : '科目',
      color: /^#[0-9a-fA-F]{6}$/.test(x.color || '') ? x.color : '#4A505C',
      show: x.show !== false,
      size: ['自動', '大', '中', '小'].indexOf(x.size) >= 0 ? x.size : '自動',
      quick: Array.isArray(x.quick) ? x.quick.filter(Boolean) : [],
      order: typeof x.order === 'number' ? x.order : 0
    };
  }).filter(function (x) { return x.name; }).sort(function (a, c) { return a.order - c.order; });
}

function isWeekend(s) { var w = dparse(s).getDay(); return w === 0 || w === 6; }
function dayTypeOf(date) {
  var d = (cache.days || {})[date];
  if (DAY_TYPES.indexOf(d) >= 0) return { type: d, auto: false };
  return { type: isWeekend(date) ? '停課' : '上課', auto: true };
}
function prevSchoolDay(date) {
  var d = dparse(date);
  for (var i = 0; i < 30; i++) { d.setDate(d.getDate() - 1); var s = dfmt(d); if (dayTypeOf(s).type !== '停課') return s; }
  return '';
}
function nextSchoolDay(date) {
  var d = dparse(date);
  for (var i = 0; i < 30; i++) { d.setDate(d.getDate() + 1); var s = dfmt(d); if (dayTypeOf(s).type !== '停課') return s; }
  return '';
}

function itemsOf(date) {
  var it = dayCache['items|' + date] || {};
  return Object.keys(it).map(function (id) {
    var x = it[id] || {};
    return { id: id, block: x.block || '', text: x.text || '', grade: !!x.grade, order: x.order || 0 };
  }).filter(function (x) { return x.text; }).sort(function (a, b) { return a.order - b.order; });
}

function pendingDue(date) {
  if (dayTypeOf(date).type === '停課') return [];
  var from = prevSchoolDay(date);
  if (!from) return [];
  var types = {};
  blockList().forEach(function (b) { types[b.name] = b.type; });
  var links = cache.links || {};
  return itemsOf(from).filter(function (it) { return it.grade && types[it.block] !== '提醒' && !links[it.id]; });
}

function defaultLayout(size) {
  var rows = [];
  for (var r = 0; r < Math.ceil(size / 6); r++) {
    var line = [];
    for (var c = 1; c <= 6; c++) { var n = r * 6 + c; line.push(n <= size ? n : 0); }
    rows.push(line);
  }
  return rows;
}

/** 座位表：去掉不存在的座號，沒排到的座號補在最後一列 */
function layoutFor(size) {
  var L = Array.isArray(cache.layout) ? cache.layout : null;
  if (!L || !L.length) return null;
  var used = {};
  var rows = L.map(function (r) {
    return (Array.isArray(r) ? r : []).map(function (v) {
      var n = parseInt(v, 10);
      if (n >= 1 && n <= size && !used[n]) { used[n] = true; return n; }
      return null;
    });
  }).filter(function (r) { return r.some(function (x) { return x; }); });
  if (!rows.length) return null;
  var cols = 0;
  rows.forEach(function (r) { cols = Math.max(cols, r.length); });
  rows = rows.map(function (r) { while (r.length < cols) r.push(null); return r; });
  var missing = [];
  for (var n = 1; n <= size; n++) if (!used[n]) missing.push(n);
  while (missing.length) {
    var line = missing.splice(0, cols);
    while (line.length < cols) line.push(null);
    rows.push(line);
  }
  return rows;
}

/** 組出畫面用的 state（欄位和舊版 Apps Script 回傳的一樣，畫面程式不用大改） */
function buildState(date) {
  var st = settings();
  var recs = dayCache['records|' + date] || {};
  var assignments = Object.keys(recs).map(function (aid) {
    var r = recs[aid] || {};
    var seats = [];
    for (var n = 1; n <= st.size; n++) {
      var v = r.seats ? r.seats[n] : null;
      seats.push(STATUS_LIST.indexOf(v) >= 0 ? v : '未交');
    }
    return { row: aid, title: r.title || '', seats: seats, order: r.order || 0 };
  }).sort(function (a, b) { return a.order - b.order; });
  var lv = dayCache['leave|' + date] || {};
  var leave = Object.keys(lv).map(Number).filter(function (n) { return n >= 1 && n <= st.size; }).sort(function (a, b) { return a - b; });
  var picked = cache.picked && cache.picked.date === date && Array.isArray(cache.picked.seats) ? cache.picked.seats : [];
  var base = location.href.split('?')[0].split('#')[0];
  return {
    date: date,
    day: dayTypeOf(date),
    className: st.className,
    size: st.size,
    privacy: st.privacy,
    displayMode: st.displayMode,
    announce: st.announce,
    weekStart: st.weekStart,
    leave: leave,
    layout: layoutFor(st.size),
    blocks: blockList(),
    items: itemsOf(date),
    dueFrom: prevSchoolDay(date),
    dueOn: nextSchoolDay(date),
    duePending: pendingDue(date),
    assignments: assignments,
    tool: cache.tool || null,
    picked: picked,
    last: (cache.meta && cache.meta.last) || '',
    displayUrl: base + '?view=display',
    diaryUrl: base + '?view=diary'
  };
}

/** 批改日（今天或以前、上課日）：把前一個上課日聯絡簿中要批改的項目建立成卡片。
    用 transaction 建立，兩台裝置同時打開也不會重複，也不會蓋掉已登記的資料。 */
function syncDue(date, today) {
  if (date > today || syncing[date]) return;
  var todo = pendingDue(date);
  if (!todo.length) return;
  syncing[date] = true;
  Promise.all(todo.map(function (it, i) {
    var aid = 'L' + it.id;
    return dref('records/' + date + '/' + aid).transaction(function (cur) {
      return cur === null ? { title: it.text, order: Date.now() + i, src: it.id } : undefined;
    }).then(function () {
      return dref('links/' + it.id).set({ due: date, aid: aid });
    });
  })).then(function () {
    return touch('已從聯絡簿建立 ' + todo.length + ' 項批改作業');
  }).then(function () { syncing[date] = false; }, function () { syncing[date] = false; });
}

function touch(msg) { return dref('meta').set({ last: msg, at: serverNow() }); }

/* ---------- 寫入功能（名稱與參數沿用舊版，畫面程式直接呼叫） ---------- */

function sizeNow() { return settings().size; }
function needSeat(seat) {
  seat = Number(seat);
  if (!(seat >= 1 && seat <= sizeNow())) throw new Error('座號必須在 1 到 ' + sizeNow() + ' 之間。');
  return seat;
}
function needRecord(date, aid) {
  if (!(dayCache['records|' + date] || {})[aid]) throw new Error('這項作業已被其他裝置刪除，畫面會自動更新。');
}
function itemDate(id) {
  for (var k in dayCache) {
    if (k.indexOf('items|') === 0 && dayCache[k] && dayCache[k][id]) return k.split('|')[1];
  }
  throw new Error('找不到這一項，可能已被其他裝置刪除。');
}

var API = {
  setStatus: function (date, aid, title, seat, status) {
    if (STATUS_LIST.indexOf(status) < 0) throw new Error('未知的狀態');
    seat = needSeat(seat); needRecord(date, aid);
    var up = {};
    up['records/' + date + '/' + aid + '/seats/' + seat] = status === '未交' ? null : status;
    up['meta'] = { last: title + ' ' + seat + ' 號 → ' + status, at: serverNow() };
    return dref().update(up);
  },
  setAll: function (date, aid, title, status) {
    needRecord(date, aid);
    var seats = {};
    for (var n = 1; n <= sizeNow(); n++) seats[n] = status;
    var up = {};
    up['records/' + date + '/' + aid + '/seats'] = seats;
    up['meta'] = { last: title + ' 全班 → ' + status, at: serverNow() };
    return dref().update(up);
  },
  addAssignment: function (date, title) {
    checkDate(date);
    title = cleanText(title);
    if (!title) throw new Error('作業名稱不能空白。');
    return dref('records/' + date).push({ title: title, order: Date.now() }).then(function () { return touch('新增作業：' + title); });
  },
  renameAssignment: function (date, aid, oldTitle, newTitle) {
    newTitle = cleanText(newTitle);
    if (!newTitle) throw new Error('作業名稱不能空白。');
    needRecord(date, aid);
    return dref('records/' + date + '/' + aid + '/title').set(newTitle).then(function () { return touch(oldTitle + ' 改名為 ' + newTitle); });
  },
  deleteAssignment: function (date, aid, title) {
    // 聯絡簿的連動紀錄保留，卡片才不會在下次打開時被重新建立
    return dref('records/' + date + '/' + aid).remove().then(function () { return touch('刪除作業：' + title); });
  },
  setDayType: function (date, type) {
    checkDate(date);
    if (DAY_TYPES.indexOf(type) < 0) throw new Error('未知的日子類型');
    var deflt = isWeekend(date) ? '停課' : '上課';
    return dref('days/' + date).set(type === deflt ? null : type).then(function () { return touch(date + ' 設為' + type + '日'); });
  },
  toggleLeave: function (date, seat, on) {
    seat = needSeat(seat);
    return dref('leave/' + date + '/' + seat).set(on ? true : null).then(function () { return touch(seat + ' 號' + (on ? '請假' : '取消請假')); });
  },
  setPrivacy: function (on) { return dref('settings/privacy').set(!!on); },
  setDisplayMode: function (m) {
    if (m !== '作業看板' && m !== '聯絡簿') throw new Error('未知的畫面');
    return dref('settings/displayMode').set(m).then(function () { return touch('大螢幕切換為' + m); });
  },
  setAnnouncement: function (text) {
    text = cleanText(text, 80);
    return dref('settings/announce').set(text).then(function () { return touch(text ? '公告：' + text : '公告已清除'); });
  },
  saveSettings: function (o) {
    var className = cleanText(o.className, 20);
    var size = parseInt(o.size, 10);
    if (!(size >= 1 && size <= 60)) throw new Error('全班人數請填 1 到 60。');
    if (o.weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(o.weekStart)) throw new Error('週次起算日格式錯誤。');
    return dref('settings').update({ className: className, size: size, weekStart: o.weekStart || '' }).then(function () { return touch('班級設定已更新'); });
  },
  saveLayout: function (rows) {
    return dref('layout').set(rows && rows.length ? rows : null).then(function () { return touch('座位表已更新'); });
  },

  /* 倒數計時與抽籤 */
  toolTimer: function (action, seconds) {
    var t = cache.tool;
    var now = serverNow();
    if (action === 'start') {
      seconds = Math.round(Number(seconds));
      if (!(seconds >= 5 && seconds <= 7200)) throw new Error('時間請設定在 5 秒到 120 分鐘之間。');
      t = { type: 'timer', total: seconds, end: now + seconds * 1000 };
    } else if (!t || t.type !== 'timer') {
      throw new Error('目前沒有正在進行的倒數。');
    } else if (action === 'pause' && t.end) {
      t = { type: 'timer', total: t.total, left: Math.max(0, t.end - now) };
    } else if (action === 'resume' && t.left != null) {
      t = { type: 'timer', total: t.total, end: now + t.left };
    } else if (action === 'stop') {
      t = null;
    }
    return dref('tool').set(t);
  },
  toolPick: function (date, noRepeat) {
    var size = sizeNow();
    var leave = dayCache['leave|' + date] || {};
    var picked = cache.picked && cache.picked.date === date && Array.isArray(cache.picked.seats) ? cache.picked.seats.slice() : [];
    var pool = [], all = [];
    for (var n = 1; n <= size; n++) {
      if (leave[n]) continue;
      all.push(n);
      if (!noRepeat || picked.indexOf(n) < 0) pool.push(n);
    }
    if (!all.length) throw new Error('沒有可以抽的學生。');
    var restarted = false;
    if (!pool.length) { pool = all; picked = []; restarted = true; }
    var seat = pool[Math.floor(Math.random() * pool.length)];
    picked.push(seat);
    return dref().update({
      picked: { date: date, seats: picked },
      tool: { type: 'pick', seat: seat, at: serverNow() },
      meta: { last: '抽到 ' + seat + ' 號', at: serverNow() }
    }).then(function () { return { seat: seat, restarted: restarted }; });
  },
  toolResetPicked: function () { return dref('picked').remove(); },
  toolClose: function () { return dref('tool').remove(); },

  /* 聯絡簿 */
  addDiaryItem: function (date, block, text) {
    checkDate(date);
    text = cleanText(text);
    if (!text) throw new Error('內容不能空白。');
    var b = null;
    blockList().forEach(function (x) { if (x.name === block) b = x; });
    if (!b) throw new Error('找不到區塊：' + block);
    var grade = b.type === '科目' && !DATA_NO_GRADE_RE.test(text);
    return dref('items/' + date).push({ block: b.name, text: text, grade: grade, order: Date.now() })
      .then(function () { return touch(b.name + '：新增「' + text + '」'); });
  },
  updateDiaryItem: function (id, text) {
    text = cleanText(text);
    if (!text) throw new Error('內容不能空白。');
    var d = itemDate(id);
    var up = {};
    up['items/' + d + '/' + id + '/text'] = text;
    var lk = (cache.links || {})[id];
    return (lk ? dref('records/' + lk.due + '/' + lk.aid).once('value') : Promise.resolve(null)).then(function (snap) {
      if (lk && snap && snap.val()) up['records/' + lk.due + '/' + lk.aid + '/title'] = text;
      up['meta'] = { last: '聯絡簿項目改為「' + text + '」', at: serverNow() };
      return dref().update(up);
    });
  },
  deleteDiaryItem: function (id) {
    var d = itemDate(id);
    return unlinkCard(id).then(function (warning) {
      return dref('items/' + d + '/' + id).remove().then(function () { return touch('刪除聯絡簿項目'); })
        .then(function () { return { warning: warning }; });
    });
  },
  setDiaryGrade: function (id, on) {
    var d = itemDate(id);
    return dref('items/' + d + '/' + id + '/grade').set(!!on).then(function () {
      return on ? '' : unlinkCard(id);
    }).then(function (warning) { return { warning: warning }; });
  },
  copyDiary: function (fromDate, toDate) {
    checkDate(fromDate); checkDate(toDate);
    return Promise.all([dref('items/' + fromDate).once('value'), dref('items/' + toDate).once('value')]).then(function (s) {
      var src = s[0].val() || {}, dst = s[1].val() || {};
      var have = {};
      Object.keys(dst).forEach(function (k) { have[dst[k].block + '|' + dst[k].text] = true; });
      var ids = Object.keys(src).sort(function (a, b) { return (src[a].order || 0) - (src[b].order || 0); });
      var up = {}, count = 0;
      ids.forEach(function (k, i) {
        var it = src[k];
        if (!it || !it.text || have[it.block + '|' + it.text]) return;
        var nk = dref('items/' + toDate).push().key;
        up['items/' + toDate + '/' + nk] = { block: it.block, text: it.text, grade: !!it.grade, order: Date.now() + i };
        count++;
      });
      if (!count) throw new Error(ids.length ? '內容都已經在今天的聯絡簿裡了。' : '那一天的聯絡簿沒有內容。');
      up['meta'] = { last: '複製了 ' + count + ' 項聯絡簿內容', at: serverNow() };
      return dref().update(up).then(function () { return { count: count }; });
    });
  },

  /* 聯絡簿區塊 */
  setBlock: function (name, field, value) {
    var b = findBlock(name);
    if (field === 'show') return dref('blocks/' + b.id + '/show').set(!!value);
    if (field === 'size') {
      if (['自動', '大', '中', '小'].indexOf(value) < 0) throw new Error('未知的字級');
      return dref('blocks/' + b.id + '/size').set(value);
    }
    if (field === 'quick') return dref('blocks/' + b.id + '/quick').set(value);
    throw new Error('未知的設定');
  },
  moveBlock: function (name, dir) {
    var list = blockList();
    var i = -1;
    list.forEach(function (b, k) { if (b.name === name) i = k; });
    var j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return Promise.resolve();
    var up = {};
    list.splice(j, 0, list.splice(i, 1)[0]);
    list.forEach(function (b, k) { up['blocks/' + b.id + '/order'] = k; });
    return dref().update(up);
  },
  addBlock: function (name, type) {
    name = cleanText(name, 12);
    if (!name) throw new Error('區塊名稱請在 1 到 12 字之間。');
    var list = blockList();
    if (list.some(function (b) { return b.name === name; })) throw new Error('已經有「' + name + '」這個區塊了。');
    type = type === '提醒' ? '提醒' : '科目';
    // 新的科目放在提醒類區塊前面
    var at = list.length;
    if (type === '科目') list.forEach(function (b, k) { if (b.type === '提醒' && k < at) at = k; });
    var nk = dref('blocks').push().key;
    var up = {};
    list.splice(at, 0, { id: nk });
    list.forEach(function (b, k) { up['blocks/' + b.id + '/order'] = k; });
    up['blocks/' + nk] = { name: name, type: type, color: BLOCK_PALETTE[list.length % BLOCK_PALETTE.length], show: true, size: '自動', quick: [], order: at };
    return dref().update(up);
  },
  deleteBlock: function (name) {
    var b = findBlock(name);
    return dref('blocks/' + b.id).remove();
  },

  /* 查詢 */
  rangeTrack: function (seat, start, end) {
    checkDate(start); checkDate(end);
    if (start > end) throw new Error('開始日期不能晚於結束日期。');
    seat = needSeat(seat);
    return Promise.all([
      dref('records').orderByKey().startAt(start).endAt(end).once('value'),
      dref('leave').orderByKey().startAt(start).endAt(end).once('value')
    ]).then(function (s) {
      var recs = s[0].val() || {}, leave = s[1].val() || {};
      var missing = [], toCorrect = [], skipped = 0, leaveDays = [];
      for (var d = dparse(start); dfmt(d) <= end; d.setDate(d.getDate() + 1)) {
        var ds = dfmt(d);
        if (dayTypeOf(ds).type === '停課') { skipped++; continue; }
        if (leave[ds] && leave[ds][seat]) { leaveDays.push(ds); continue; }
        var day = recs[ds] || {};
        Object.keys(day).sort(function (a, b) { return (day[a].order || 0) - (day[b].order || 0); }).forEach(function (aid) {
          var v = day[aid].seats ? day[aid].seats[seat] : null;
          if (!v || v === '未交') missing.push({ date: ds, title: day[aid].title });
          if (v === '待訂正') toCorrect.push({ date: ds, title: day[aid].title });
        });
      }
      return { seat: seat, start: start, end: end, missing: missing, toCorrect: toCorrect, skipped: skipped, leaveDays: leaveDays };
    });
  },
  exportRows: function (start, end) {
    checkDate(start); checkDate(end);
    var size = sizeNow();
    return Promise.all([
      dref('records').orderByKey().startAt(start).endAt(end).once('value'),
      dref('leave').orderByKey().startAt(start).endAt(end).once('value')
    ]).then(function (s) {
      var recs = s[0].val() || {}, leave = s[1].val() || {};
      var head = ['日期', '作業'];
      for (var n = 1; n <= size; n++) head.push(n + '號');
      var rows = [head];
      Object.keys(recs).sort().forEach(function (ds) {
        var day = recs[ds] || {};
        Object.keys(day).sort(function (a, b) { return (day[a].order || 0) - (day[b].order || 0); }).forEach(function (aid) {
          var line = [ds, day[aid].title || ''];
          for (var n = 1; n <= size; n++) {
            var v = leave[ds] && leave[ds][n] ? '請假' : (day[aid].seats && day[aid].seats[n]) || '未交';
            line.push(v);
          }
          rows.push(line);
        });
      });
      return rows;
    });
  }
};

function findBlock(name) {
  var r = null;
  blockList().forEach(function (b) { if (b.name === name) r = b; });
  if (!r) throw new Error('找不到區塊：' + name);
  return r;
}

/** 刪除或取消批改時處理已建立的卡片：沒登記過就一起刪，已有登記就保留並回傳提醒 */
function unlinkCard(id) {
  var lk = (cache.links || {})[id];
  if (!lk) return Promise.resolve('');
  var path = 'records/' + lk.due + '/' + lk.aid;
  return dref(path).once('value').then(function (s) {
    var r = s.val();
    var warning = '';
    var up = {};
    up['links/' + id] = null;
    if (r) {
      var touched = r.seats && Object.keys(r.seats).some(function (k) { return r.seats[k] && r.seats[k] !== '未交'; });
      if (touched) {
        var d = dparse(lk.due);
        warning = (d.getMonth() + 1) + '/' + d.getDate() + ' 繳交看板上的「' + (r.title || '') + '」已經有登記紀錄，所以保留下來，需要的話請到繳交看板手動刪除。';
      } else {
        up[path] = null;
      }
    }
    return dref().update(up).then(function () { return warning; });
  });
}
