/* TradingAgents 报告站 前端逻辑 */
(function () {
  "use strict";

  let REPORTS = [];
  let BRIEF = null;
  let STRATEGY = [];
  let TDOCS = [];
  let SPECIALS = [];
  let TUTORIAL_GROUPS = [];
  let currentId = null;
  let currentView = null; // 'report' | 'doc'
  let keyword = "";
  let ratingFilter = "";
  let dateFilter = "";
  const expanded = {}; // ticker -> bool（默认展开）
  const expandedDates = {}; // 日期 -> bool（默认展开）
  let showAllDocs = false;  // 每日文档：默认只显示最近 1 天

  const $list = document.getElementById("reportList");
  const $docsList = document.getElementById("docsList");
  const $specialList = document.getElementById("specialList");
  const $tutorialsList = document.getElementById("tutorialsList");
  const $main = document.getElementById("main");
  const $search = document.getElementById("search");
  const $rating = document.getElementById("ratingFilter");
  const $date = document.getElementById("dateFilter");
  const $subtitle = document.getElementById("subtitle");
  const $summaryEntry = document.getElementById("summaryEntry");
  const $featuredEntry = document.getElementById("featuredEntry");

  // ---------- 精选标的（精选页栏目，可点击切换） ----------
  const FEATURED = [
    { ticker: "513750.SS", label: "恒生互联网" },
    { ticker: "159949.SZ", label: "创业板50" },
    { ticker: "159869.SZ", label: "游戏" },
    { ticker: "512980.SS", label: "媒体" },
    { ticker: "588200.SS", label: "芯片" },
    { ticker: "512100.SS", label: "中证1000" },
    { ticker: "510300.SS", label: "沪深300" },
  ];
  const $menuToggle = document.getElementById("menuToggle");
  const $sidebar = document.querySelector(".sidebar");
  const $mask = document.getElementById("sidebarMask");

  // ---------- 移动端抽屉菜单 ----------
  let keepDrawer = false; // 筛选/搜索触发的重渲染不收起抽屉（过滤就是操作菜单本身）
  function isMobile() {
    return window.matchMedia("(max-width: 900px)").matches;
  }
  function closeDrawer() {
    if (keepDrawer) return;
    $sidebar.classList.remove("open");
    $mask.classList.remove("show");
  }
  $menuToggle.addEventListener("click", function () {
    const open = !$sidebar.classList.contains("open");
    $sidebar.classList.toggle("open", open);
    $mask.classList.toggle("show", open);
  });
  $mask.addEventListener("click", closeDrawer);
  window.addEventListener("resize", function () {
    if (!isMobile()) closeDrawer();
  });

  marked.setOptions({ breaks: true, gfm: true });

  // ---------- Hash 路由（支持浏览器/手机滑动回退） ----------
  // 格式：#/ （总结页） | #/r/<报告id> | #/d/<文档id> ，后跟 ?q=<关键词>&f=<评级筛选>&d=<日期筛选>
  function buildHash(view, id) {
    const params = [];
    if (keyword) params.push("q=" + encodeURIComponent(keyword));
    if (ratingFilter) params.push("f=" + encodeURIComponent(ratingFilter));
    let h = "#/";
    if (view === "report" && id) h = "#/r/" + encodeURIComponent(id);
    else if (view === "doc" && id) h = "#/d/" + encodeURIComponent(id);
    else if (view === "special" && id) h = "#/s/" + encodeURIComponent(id);
    else if (view === "tutorial" && id) h = "#/t/" + encodeURIComponent(id);
    else if (view === "featured") h = "#/f/" + (id ? encodeURIComponent(id) : "");
    else if (view === "mode") h = "#/m";
    else if (view === "fail") h = "#/fail";
    else if (view === "nav") h = "#/nv";
    // 日期筛选始终写入 hash（可为空串表示"全部日期"），以便区分"未指定"与"显式选全部"
    params.push("d=" + encodeURIComponent(dateFilter));
    if (params.length) h += "?" + params.join("&");
    return h;
  }

  function parseHash() {
    let h = location.hash || "#/";
    if (h.charAt(0) === "#") h = h.slice(1);
    const qIdx = h.indexOf("?");
    const query = qIdx >= 0 ? h.slice(qIdx + 1) : "";
    const path = qIdx >= 0 ? h.slice(0, qIdx) : h;
    const params = new URLSearchParams(query);
    let view = "summary", id = null;
    if (path.indexOf("/r/") === 0) { view = "report"; id = decodeURIComponent(path.slice(3)); }
    else if (path.indexOf("/d/") === 0) { view = "doc"; id = decodeURIComponent(path.slice(3)); }
    else if (path.indexOf("/s/") === 0) { view = "special"; id = decodeURIComponent(path.slice(3)); }
    else if (path.indexOf("/t/") === 0) { view = "tutorial"; id = decodeURIComponent(path.slice(3)); }
    else if (path.indexOf("/f/") === 0) { view = "featured"; id = decodeURIComponent(path.slice(3)); }
    else if (path === "/m" || path.indexOf("/m/") === 0) { view = "mode"; }
    else if (path === "/fail" || path.indexOf("/fail/") === 0) { view = "fail"; }
    else if (path === "/nv" || path.indexOf("/nv/") === 0) { view = "nav"; }
    return { view: view, id: id, q: params.get("q") || "", f: params.get("f") || "",
      d: params.has("d") ? (params.get("d") || "") : null }; // d 缺失=null（用默认当日），d= 空串=显式全部日期
  }

  function navigate(view, id) {
    const h = buildHash(view, id);
    if (location.hash === h) applyHash(); // 同地址重复点击也刷新视图
    else location.hash = h; // 触发 hashchange -> applyHash
  }

  function applyHash() {
    const st = parseHash();
    keyword = st.q;
    ratingFilter = st.f;
    dateFilter = (st.d === null) ? defaultDate() : st.d;
    $search.value = st.q;
    $rating.value = st.f;
    $date.value = dateFilter;
    renderTree();
    renderSpecials();
    renderTutorials();
    if (TDOCS.length) renderDocs();
    if (st.view === "report" && findReport(st.id)) {
      renderReport(st.id);
    } else if (st.view === "featured") {
      renderFeatured(FEATURED.some(function (f) { return f.ticker === st.id; }) ? st.id : FEATURED[0].ticker);
    } else if (st.view === "mode") {
      renderModeView();
    } else if (st.view === "fail") {
      renderFailView();
    } else if (st.view === "nav") {
      renderNavView();
    } else if (st.view === "special") {
      const sp = SPECIALS.find(function (s) { return s.id === st.id; });
      if (sp) renderSpecial(sp);
      else renderSummaryView(); // 专题未加载/不存在，先回总结页
    } else if (st.view === "tutorial") {
      const tut = findTutorial(st.id);
      if (tut) renderTutorial(tut);
      else renderSummaryView(); // 教程未加载/不存在，先回总结页
    } else if (st.view === "doc") {
      const doc = TDOCS.find(function (d) { return d.id === st.id; });
      if (doc) renderDoc(doc);
      else renderSummaryView(); // 文档未加载/不存在，先回总结页
    } else {
      renderSummaryView();
    }
    keepDrawer = false; // 筛选状态处理完毕，恢复默认关闭行为
  }

  window.addEventListener("hashchange", applyHash);

  // ---------- 评级 ----------
  function ratingClass(rating) {
    if (!rating) return "hold";
    const r = rating.toLowerCase();
    if (/(买入|增持|overweight|buy|accumulate|strong)/.test(r)) return "buy";
    if (/(卖出|减持|回避|underweight|sell|reduce)/.test(r)) return "sell";
    return "hold";
  }

  function ratingScore(rating) {
    if (!rating) return 0;
    const c = ratingClass(rating);
    return c === "buy" ? 2 : c === "sell" ? -2 : 0;
  }

  // 五档评级排序优先级：买入 > 增持 > 持有 > 减持 > 卖出
  function ratingRank(rating) {
    const order = ["卖出", "减持", "持有", "增持", "买入"];
    const i = order.indexOf(rating);
    return i === -1 ? 0 : i; // 未知/缺失按"持有"档处理
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- 侧栏高亮同步 ----------
  function syncSidebarActive() {
    $summaryEntry.classList.toggle("active", currentView === "summary" || currentView === "mode");
    $featuredEntry.classList.toggle("active", currentView === "featured");
  }

  // ---------- 总结/模式 切换 tabs（总结页与模式页共用） ----------
  function renderViewTabs(active) {
    let html = '<div class="tabs ftabs vtabs">';
    html += '<button class="tab' + (active === "summary" ? " active" : "") + '" data-vtab="summary">📋 近一周总结</button>';
    html += '<button class="tab' + (active === "mode" ? " active" : "") + '" data-vtab="mode">🎯 交易模式</button>';
    html += '<button class="tab' + (active === "fail" ? " active" : "") + '" data-vtab="fail">💔 失败总结</button>';
    html += '<button class="tab' + (active === "nav" ? " active" : "") + '" data-vtab="nav">📈 净值</button>';
    html += "</div>";
    return html;
  }

  function bindVtabs() {
    $main.querySelectorAll(".vtabs .tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        navigate(btn.dataset.vtab);
      });
    });
  }

  // ---------- 总结页（默认首页） ----------
  function renderSummaryView() {
    currentId = null;
    currentView = "summary";
    syncSidebarActive();
    closeDrawer();
    $list.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $docsList.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });

    if (!BRIEF) {
      $main.innerHTML = '<div class="placeholder"><div class="placeholder-icon">📋</div><p>暂无总结数据，请先运行 sync.py 同步</p></div>';
      return;
    }

    let html = '<div class="summary-page">';
    html += renderViewTabs("summary");
    html += '<div class="sp-header"><h2>📋 近一周总结</h2>' +
      '<span class="sp-period">' + esc(BRIEF.start) + " ~ " + esc(BRIEF.end) + "</span></div>";

    html += '<div class="summary-stats">' +
      '<span class="stat-chip">报告 <b>' + BRIEF.reportCount + "</b> 份</span>" +
      '<span class="stat-chip">标的 <b>' + BRIEF.stockCount + "</b> 只</span>" +
      '<span class="stat-chip" style="color:var(--red);">买入 <b>' + BRIEF.buyCount + "</b></span>" +
      '<span class="stat-chip" style="color:var(--red);">增持 <b>' + (BRIEF.overweightCount || 0) + "</b></span>" +
      '<span class="stat-chip">中性/持有 <b>' + BRIEF.holdCount + "</b></span>" +
      '<span class="stat-chip" style="color:var(--green);">偏空 <b>' + BRIEF.sellCount + "</b></span>" +
      "</div>";

    html += '<div class="sp-cards">';
    if (BRIEF.bigChance && BRIEF.bigChance.length) {
      html += '<div class="sp-card chance"><h4>🚀 大概率大机会</h4><ol class="chance-list">';
      BRIEF.bigChance.forEach(function (c) {
        html += "<li>" + esc(c);
        const sp = SPECIALS.find(function (s) { return s.anchor && c.indexOf(s.anchor) !== -1; });
        if (sp) html += ' <a class="chance-link" href="#/s/' + encodeURIComponent(sp.id) + '">📊 ' + esc(sp.title.split("（")[0]) + ' ↗</a>';
        html += "</li>";
      });
      html += "</ol></div>";
    }
    html += "</div>";

    html += '<div class="summary-source">ℹ️ 本页总结与整体策略由 <b>TradingAgents 报告程序</b>自动统计得出' +
      "（基于近一周报告评级的规则化推断，非人工撰写，不构成投资建议）。</div>";

    // 整体策略——放页面最下面
    if (STRATEGY && STRATEGY.length) {
      html += '<div class="strategy-block"><h3>📌 整体策略</h3><ol>';
      STRATEGY.forEach(function (s) { html += "<li>" + esc(s) + "</li>"; });
      html += "</ol></div>";
    }
    html += "</div>";

    $main.innerHTML = html;
    bindVtabs();
    window.scrollTo({ top: 0 });
  }

  // ---------- 交易模式页（总结页第二个 tab） ----------
  const MODE_HTML =
    '<div class="mode-card">' +
    '<div class="mc-head"><h3>🏜️ 大漠模式</h3><span class="mc-tag">短线 · 操作次数较多 · 不太适合上班族</span></div>' +
    '<div class="mc-grid">' +
    '<div class="mc-block mc-in"><h4>✅ 介入条件</h4><ol>' +
    "<li><b>均线附近低吸</b>——一般上浮 2% 以内；</li>" +
    "<li><b>绿盘低吸</b>——绿盘跌几个点，需要根据自己的风险偏好抉择。</li>" +
    "</ol></div>" +
    '<div class="mc-block mc-out"><h4>🚪 调出条件</h4><ol>' +
    "<li><b>跌破预定均线止损</b>——盘中或收盘跌破预定均线（如预定 10 日均线，跌破即止损）；盘中瞬间跌破又快速收回的，可以稍微等等；</li>" +
    "<li><b>亏损超 5 个点，无条件止损</b>；</li>" +
    "<li><b>横盘超 5 个交易日离场</b>——小赚小亏都要走；</li>" +
    "<li><b>浮动止盈梯度（不止盈变亏本很被动）</b>：" +
    "<ul class=\"mc-nest\">" +
    "<li>浮盈 <b>5 个点以内</b> → 要保 2 个点，最差保本止盈；</li>" +
    "<li>浮盈 <b>10 个点以内</b> → 最差保 5 个点；</li>" +
    "<li>浮盈 <b>超 10 个点</b> → 随时考虑分批止盈；</li>" +
    "<li>遇到 <b>涨停</b> → 次日不连板走人。</li>" +
    "</ul></li>" +
    "</ol></div>" +
    "</div></div>" +
    '<div class="mode-card">' +
    '<div class="mc-head"><h3>🧓 熊市·老奶奶下楼梯模式</h3><span class="mc-tag">反弹波段 · 冰点出手 · 反弹就走</span></div>' +
    '<div class="mc-grid">' +
    '<div class="mc-block mc-in"><h4>✅ 介入条件</h4><ol>' +
    "<li><b>下楼梯阶段不接飞刀</b>——熊市里指数像老奶奶下楼梯，一阶一阶往下走；阴跌过程中空仓观望，不抢小反弹；</li>" +
    "<li><b>恐慌冰点出手</b>——指数跌到情绪极端低迷、放量急跌、市场无人敢抄的冰点，分批买入 <b>ETF 或指数</b>；</li>" +
    "<li>只做<b>反弹</b>，不做反转——赚的是恐慌修复的那一段。</li>" +
    "</ol></div>" +
    '<div class="mc-block mc-out"><h4>🚪 调出条件</h4><ol>' +
    "<li><b>反弹兑现，立马批量减仓</b>——反弹来了一段就分批卖出、锁住利润，落袋为安，绝不贪多；</li>" +
    "<li><b>卖出不回头</b>——减仓过程中不因回落又接回去，减完前不恋战；</li>" +
    "<li>清仓后<b>空仓等待</b>下一次楼梯走完的冰点。</li>" +
    "</ol></div>" +
    "</div></div>" +
    '<div class="mode-card">' +
    '<div class="mc-head"><h3>📈 右侧交易模式</h3><span class="mc-tag">牛市 · 趋势跟随 · 复利稳稳</span></div>' +
    '<div class="mc-grid">' +
    '<div class="mc-block mc-in"><h4>✅ 介入条件</h4><ol>' +
    "<li><b>牛市趋势向上</b>——只做趋势向上的行情，选<b>有业绩的成长个股</b>；</li>" +
    "<li><b>两种低吸方式</b>——回调低吸，或突破买入；</li>" +
    "<li><b>低吸过程要耐心</b>——分批建仓，不追高、不满仓一把梭。</li>" +
    "</ol></div>" +
    '<div class="mc-block mc-out"><h4>🚪 调出条件</h4><ol>' +
    "<li><b>成功：均线跟趋势</b>——持有期跟着均线走趋势，逐步清仓兑现；</li>" +
    "<li><b>破位止损离场</b>——跌破关键均线或亏 5%，无条件离场；</li>" +
    "<li><b>重复以上</b>——一笔一笔做，复利稳稳。</li>" +
    "</ol></div>" +
    "</div></div>";

  // 股票生命周期（交易模式页）
  const LIFECYCLE_HTML =
    '<div class="mode-card">' +
    '<div class="mc-head"><h3>🔄 股票生命周期</h3><span class="mc-tag">明确做哪一段 · 知道下一段的风险</span></div>' +
    '<div class="lc-flow">' +
    '<div class="lc-step lc-s1"><b>① 低位震荡吸筹</b><span>主力慢慢收集筹码，横盘磨人</span></div>' +
    '<div class="lc-arrow">→</div>' +
    '<div class="lc-step lc-s2"><b>② 拉升</b><span>趋势向上，赚钱效应最好的阶段</span></div>' +
    '<div class="lc-arrow">→</div>' +
    '<div class="lc-step lc-s3"><b>③ 派筹</b><span>高位反复，主力出货，看着像还要涨</span></div>' +
    '<div class="lc-arrow">→</div>' +
    '<div class="lc-step lc-s4"><b>④ 下跌</b><span>破位走人，不接飞刀</span></div>' +
    "</div>" +
    '<div class="lc-note">我们必须<b>明确自己做哪一段的趋势</b>，同时知道<b>下一段的风险</b>。<b>不要以为会一直涨</b>；让走势走进我们的预期里面——什么情况，就有什么样的执行计划。</div>' +
    "</div>";

  // 创业板指月线收盘（2010-06 ~ 2026-11，腾讯月线，用于牛熊周期图）
  const CYCLE_KLINE = [["2010-06","919.3"],["2010-07","968.4"],["2010-08","1025.6"],["2010-09","942.5"],["2010-10","1064.5"],["2010-11","1181.5"],["2010-12","1137.7"],["2011-01","1029.1"],["2011-02","1099.8"],["2011-03","1008.3"],["2011-04","912.7"],["2011-05","846.3"],["2011-06","845.9"],["2011-07","913.3"],["2011-08","921.5"],["2011-09","791.1"],["2011-10","852.8"],["2011-11","838.1"],["2011-12","729.5"],["2012-01","648.7"],["2012-02","735.3"],["2012-03","678.5"],["2012-04","685.1"],["2012-05","734.5"],["2012-06","726.7"],["2012-07","677.0"],["2012-08","706.6"],["2012-09","689.6"],["2012-10","691.6"],["2012-11","606.8"],["2012-12","713.9"],["2013-01","776.0"],["2013-02","861.1"],["2013-03","866.5"],["2013-04","889.4"],["2013-05","1073.0"],["2013-06","1011.7"],["2013-07","1134.0"],["2013-08","1185.2"],["2013-09","1367.9"],["2013-10","1235.6"],["2013-11","1366.8"],["2013-12","1304.4"],["2014-01","1496.0"],["2014-02","1434.9"],["2014-03","1327.8"],["2014-04","1283.2"],["2014-05","1318.1"],["2014-06","1404.7"],["2014-07","1344.5"],["2014-08","1424.5"],["2014-09","1540.9"],["2014-10","1513.3"],["2014-11","1570.8"],["2014-12","1471.8"],["2015-01","1680.6"],["2015-02","1928.0"],["2015-03","2335.2"],["2015-04","2857.9"],["2015-05","3542.8"],["2015-06","2858.6"],["2015-07","2539.8"],["2015-08","1996.9"],["2015-09","2082.7"],["2015-10","2478.3"],["2015-11","2672.6"],["2015-12","2714.1"],["2016-01","1994.1"],["2016-02","1880.2"],["2016-03","2238.3"],["2016-04","2138.7"],["2016-05","2159.8"],["2016-06","2227.8"],["2016-07","2122.4"],["2016-08","2191.8"],["2016-09","2149.9"],["2016-10","2159.8"],["2016-11","2183.1"],["2016-12","1962.1"],["2017-01","1886.2"],["2017-02","1927.2"],["2017-03","1907.3"],["2017-04","1850.7"],["2017-05","1763.7"],["2017-06","1818.1"],["2017-07","1736.3"],["2017-08","1849.4"],["2017-09","1867.0"],["2017-10","1869.8"],["2017-11","1770.3"],["2017-12","1752.7"],["2018-01","1735.1"],["2018-02","1753.6"],["2018-03","1900.5"],["2018-04","1805.6"],["2018-05","1743.7"],["2018-06","1606.7"],["2018-07","1561.3"],["2018-08","1435.2"],["2018-09","1411.3"],["2018-10","1275.6"],["2018-11","1329.4"],["2018-12","1250.5"],["2019-01","1228.0"],["2019-02","1535.7"],["2019-03","1693.5"],["2019-04","1623.8"],["2019-05","1483.7"],["2019-06","1511.5"],["2019-07","1570.4"],["2019-08","1610.9"],["2019-09","1627.5"],["2019-10","1671.3"],["2019-11","1664.9"],["2019-12","1798.1"],["2020-01","1927.7"],["2020-02","2071.6"],["2020-03","1871.9"],["2020-04","2069.4"],["2020-05","2086.7"],["2020-06","2438.2"],["2020-07","2795.4"],["2020-08","2728.3"],["2020-09","2574.8"],["2020-10","2655.9"],["2020-11","2631.9"],["2020-12","2966.3"],["2021-01","3128.9"],["2021-02","2914.1"],["2021-03","2758.5"],["2021-04","3091.4"],["2021-05","3309.1"],["2021-06","3477.2"],["2021-07","3440.2"],["2021-08","3214.1"],["2021-09","3244.7"],["2021-10","3350.7"],["2021-11","3495.6"],["2021-12","3322.7"],["2022-01","2908.9"],["2022-02","2881.3"],["2022-03","2659.5"],["2022-04","2319.1"],["2022-05","2405.1"],["2022-06","2810.6"],["2022-07","2670.4"],["2022-08","2570.4"],["2022-09","2289.0"],["2022-10","2265.1"],["2022-11","2345.3"],["2022-12","2346.8"],["2023-01","2580.8"],["2023-02","2429.0"],["2023-03","2399.5"],["2023-04","2324.7"],["2023-05","2193.4"],["2023-06","2215.0"],["2023-07","2236.7"],["2023-08","2102.6"],["2023-09","2003.9"],["2023-10","1968.2"],["2023-11","1922.6"],["2023-12","1891.4"],["2024-01","1573.4"],["2024-02","1807.0"],["2024-03","1818.2"],["2024-04","1858.4"],["2024-05","1805.1"],["2024-06","1683.4"],["2024-07","1688.1"],["2024-08","1580.5"],["2024-09","2175.1"],["2024-10","2164.5"],["2024-11","2224.0"],["2024-12","2141.6"],["2025-01","2063.8"],["2025-02","2170.4"],["2025-03","2103.7"],["2025-04","1948.0"],["2025-05","1993.2"],["2025-06","2153.0"],["2025-07","2328.3"],["2025-08","2890.1"],["2025-09","3238.2"],["2025-10","3187.5"],["2025-11","3052.6"],["2025-12","3203.2"],["2026-01","3346.4"],["2026-02","3310.3"],["2026-03","3184.9"],["2026-04","3677.2"],["2026-05","4037.9"],["2026-06","4342.7"],["2026-07","3344.0"],["2026-08","3438.7"],["2026-09","3135.3"],["2026-10","2413.6"],["2026-11","2212.1"]];

  // 牛熊周期切换（交易模式页，生命周期之下）
  // 熊市阴影带 [起月, 止月, 回撤标签]（按月收盘价计算）
  const BEAR_BANDS = [
    ["2010-11", "2012-11", "-49%"],
    ["2015-05", "2015-09", "-41%"],
    ["2015-12", "2018-10", "-53%"],
    ["2021-11", "2022-10", "-35%"],
    ["2023-01", "2024-01", "-39%"],
    ["2026-06", "2026-11", "-49%"],
  ];
  // 选举/美联储事件线（c: fed=美联储 dem=民主党 rep=共和党；lvl=标签错层 0/1/2；s=图上短标签）
  const CYCLE_EVENTS = [
    { t: "2014-11", c: "rep", d: "中期选举·共和党赢两院", lvl: 0, s: "14/11 选举·共" },
    { t: "2015-12", c: "fed", d: "美联储启动加息", lvl: 1, s: "15/12 加息" },
    { t: "2020-03", c: "fed", d: "疫情紧急降息至 0", lvl: 0, s: "20/03 降至0" },
    { t: "2020-11", c: "dem", d: "拜登（民主党）当选", lvl: 1, s: "20/11 拜登·民" },
    { t: "2022-03", c: "fed", d: "美联储启动加息", lvl: 0, s: "22/03 加息" },
    { t: "2024-09", c: "fed", d: "美联储启动降息", lvl: 0, s: "24/09 降息" },
    { t: "2024-11", c: "rep", d: "特朗普（共和党）当选", lvl: 1, s: "24/11 特朗普" },
    { t: "2025-12", c: "fed", d: "降至 3.5~3.75%", lvl: 2, s: "25/12 3.5~3.75" },
    { t: "2026-09", c: "fed", d: "加息 25bp 至 3.75~4%", lvl: 1, s: "26/09 加息" },
    { t: "2026-11", c: "dem", d: "中期选举·民主党蓝潮赢两院", lvl: 0, s: "26/11 选举·民" },
  ];
  const CYCLE_HTML =
    '<div class="mode-card">' +
    '<div class="mc-head"><h3>🌊 牛熊周期切换</h3><span class="mc-tag">周期定段 · 模式跟着周期走</span></div>' +
    '<div class="lc-flow">' +
    '<div class="lc-step lc-s2"><b>🐂 牛市</b><span>趋势向上，赚钱效应扩散——持股做右侧</span></div>' +
    '<div class="lc-arrow">→</div>' +
    '<div class="lc-step lc-s3"><b>⚠️ 顶部派筹</b><span>情绪最热、利好满天飞——开始分批兑现</span></div>' +
    '<div class="lc-arrow">→</div>' +
    '<div class="lc-step lc-s4"><b>🐻 熊市</b><span>一阶一阶阴跌——空仓等待，不接飞刀</span></div>' +
    '<div class="lc-arrow">→</div>' +
    '<div class="lc-step lc-s1"><b>🧊 冰点底部</b><span>恐慌极致、无人敢抄——分批博反弹</span></div>' +
    "</div>" +
    '<div class="lc-note">更长的背景是<b>康波周期</b>：康波（50~60 年技术大周期）→ 朱格拉周期（约 10 年设备投资）→ 库存周期（约 3~4 年）逐级嵌套，决定牛熊的大方向。我们没有能力预测周期拐点，但可以<b>确认当下处于哪一段</b>：牛市做右侧、熊市做冰点反弹、顶部派筹段减仓兑现——<b>模式跟着周期走，仓位跟着模式走</b>。</div>' +
    // 创业板指实测月线图（熊市阴影带画在图上 + 选举/美联储事件线 + 大顶标记）
    '<div class="pc-title" style="margin-top:14px;">📈 创业板指月线实测 · 顶到顶 ≈ 一个牛熊周期<span class="pc-hint">（红区=熊市·按月收盘计，可拖拽缩放）</span></div>' +
    '<div class="pc-body pc-cycle" id="cycleChartBody"><div class="loading">月线加载中…</div></div>' +
    '<div class="pt-legend">' +
    '<i class="lg lg-fed"></i><b>美联储</b>：2015-12 启动加息 ｜ 2020-03 降息至 0 ｜ 2022-03 启动加息 ｜ 2024-09 启动降息 ｜ 2025-12 降至 3.5~3.75% ｜ 2026-09 加息至 3.75~4%' +
    "</div>" +
    '<div class="pt-legend">' +
    '<i class="lg lg-rep"></i><b>共和党</b>：2014-11 中期选举赢两院、2024-11 特朗普当选&emsp;' +
    '<i class="lg lg-dem"></i><b>民主党</b>：2020-11 拜登当选、2026-11 中期选举蓝潮赢两院' +
    "</div>" +
    '<div class="pt-note">两个大顶之间隔着一次完整的牛熊轮回——机会等得来，别怕错过。再看一个细节：<b>三次大顶之后约半年，美联储都开启了新一轮加息</b>（2015-12 / 2022-03 / 2026-09）——顶部的流动性收紧，往往就是牛熊切换的发令枪。</div>' +
    "</div>";

  // 交易纪律（交易模式页，每一条都是真金白银换来的）
  const DISCIPLINE_HTML =
    '<div class="mode-card">' +
    '<div class="mc-head"><h3>📜 交易纪律</h3><span class="mc-tag">每一条都是真金白银换来的</span></div>' +
    '<ul class="disc-list">' +
    "<li><b>🎯 选股建仓</b>——要保本、要低吸、要主线、要止损，直接干机构龙头大盘股；右侧交易：低吸 + 五日均线，小分批；分行业多方向博概率（比如 4 个方向）。</li>" +
    "<li><b>➕ 加仓纪律</b>——加仓必须有利润垫；下跌、破均线绝不可以加仓（还要考虑止损）；亏损说明是错的，不能加仓摊薄，让仅有的仓位自己跌。</li>" +
    "<li><b>💰 止盈纪律</b>——没有坚持计划止盈是大忌：破了 5 日线没减仓、还抱幻想，是错的。必须保 5 个点、保 2 个点；每次止盈挣一点，积少成多，不要贪心——实测一组 113 → 107 → 106 → 102 → 100 → 99，不止盈就回吐 14.3。</li>" +
    "<li><b>⚠️ 错误处理</b>——破均线亏本，说明进场不符合预期了，就是错误；问自己：不行动、亏损更大，能接受吗？</li>" +
    "<li><b>🥁 自己的节奏</b>——有自己的节奏和判断，一笔一笔做，不被短期波动影响。</li>" +
    "<li><b>🔄 轮动信号</b>——别的涨了、美股涨了，要小心手上没涨的一起回调；大涨一天不是机会，只有趋势向上才是机会；在趋势回调中低吸，配合板块热度，还不能破位。</li>" +
    "<li><b>🧨 庞氏骗局</b>——初期少量尝试 → 正反馈 → 忘记风险 → 投入巨大 → 负反馈巨大；警惕相信一个人或一件事的极端后果。</li>" +
    "<li><b>🛡️ 回撤控制</b>——控制回撤（大漠模式 4%），10% 真是大了。</li>" +
    "</ul></div>";

  function renderModeView() {
    currentId = null;
    currentView = "mode";
    syncSidebarActive();
    closeDrawer();
    $list.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $docsList.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $main.innerHTML =
      '<div class="summary-page">' +
      renderViewTabs("mode") +
      '<div class="sp-header"><h2>🎯 交易模式</h2><span class="sp-period">纪律先于预测</span></div>' +
      // 白板金句
      '<div class="wb-quote">💡 错过了这次，可以等下次——机会多的是，只要耐心等待下一个适合自己的买点。</div>' +
      // 交易体系白板——放页面最上方（点击看原图）
      '<div class="sp-image"><img src="assets/whiteboard.jpg" alt="交易体系白板" loading="lazy">' +
      '<div class="sp-image-caption">📌 交易体系白板（点击查看原图）</div></div>' +
      MODE_HTML +
      LIFECYCLE_HTML +
      CYCLE_HTML +
      DISCIPLINE_HTML +
      "</div>";
    const wb = $main.querySelector(".sp-image img");
    if (wb) wb.addEventListener("click", function () { window.open(wb.src, "_blank", "noopener"); });
    drawCycleChart();
    bindVtabs();
    window.scrollTo({ top: 0 });
  }

  // ---------- 失败总结页（总结页第三个 tab） ----------
  function renderFailView() {
    currentId = null;
    currentView = "fail";
    syncSidebarActive();
    closeDrawer();
    $list.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $docsList.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });

    let html = '<div class="summary-page">';
    html += renderViewTabs("fail");
    html += '<div class="sp-header"><h2>💔 失败总结</h2><span class="sp-period">用真金白银换来的教训</span></div>';

    const cases = (BRIEF && BRIEF.failCases) ? BRIEF.failCases : [];
    if (cases.length) {
      html += '<div class="sp-cards">';
      html += '<div class="sp-card fail"><h4>📉 失败案例</h4><ol class="chance-list">';
      cases.forEach(function (c) { html += "<li>" + esc(c) + "</li>"; });
      html += "</ol>";
      if (BRIEF && BRIEF.failLesson) html += '<div class="fail-lesson">📌 教训：' + esc(BRIEF.failLesson) + "</div>";
      html += "</div></div>";
    } else {
      html += '<div class="placeholder"><div class="placeholder-icon">💔</div><p>暂无失败总结数据，请先运行 sync.py 同步</p></div>';
    }
    html += "</div>";
    $main.innerHTML = html;
    bindVtabs();
    window.scrollTo({ top: 0 });
  }

  // ---------- 净值页（总结页第四个 tab；数据手工维护，追加 NAV_DATA 即可） ----------
  const NAV_DATA = [
    ["2026-11-13", 105.8],
    ["2026-11-16", 101.6],
    ["2026-11-17", 100.3],
    ["2026-11-18", 100.0],
    ["2026-11-19", 100.0],
    ["2026-11-20", 98.7],
    ["2026-11-24", 99.1],
    ["2026-11-25", 98.1],
    ["2026-11-27", 101.2],
  ];

  function drawNavChart() {
    const body = document.getElementById("navChartBody");
    if (!body || !window.LightweightCharts || !NAV_DATA.length) return;
    body.innerHTML = "";
    const isDark = document.body.classList.contains("dark");
    const textCol = isDark ? "#adb5bd" : "#495057";
    const chart = LightweightCharts.createChart(body, {
      height: body.clientWidth < 640 ? 260 : 320,
      layout: { background: { color: "transparent" }, textColor: textCol, fontSize: 11 },
      grid: { vertLines: { color: "rgba(128,134,139,.12)" }, horzLines: { color: "rgba(128,134,139,.12)" } },
      timeScale: { borderColor: "rgba(128,134,139,.25)", timeVisible: false },
      rightPriceScale: { borderColor: "rgba(128,134,139,.25)" },
      crosshair: { mode: 0 },
    });
    const series = chart.addSeries(LightweightCharts.AreaSeries, {
      lineColor: "#1971c2", topColor: "rgba(25,113,194,.25)", bottomColor: "rgba(25,113,194,.02)", lineWidth: 2,
    });
    series.setData(NAV_DATA.map(function (d) { return { time: d[0], value: d[1] }; }));
    // 每个点位标数值：高于基准 100 红色（涨）、低于绿色（跌）
    // v5 移除了 series.setMarkers，改用全局 createSeriesMarkers
    LightweightCharts.createSeriesMarkers(series, NAV_DATA.map(function (d) {
      return {
        time: d[0], position: "aboveBar",
        color: d[1] >= 100 ? "#e03131" : "#2f9e44", shape: "circle",
        text: d[1].toFixed(1),
      };
    }));
    series.createPriceLine({
      value: 100, color: "#f08c00", lineWidth: 1, lineStyle: 2,
      axisLabelVisible: true, title: "基准 100",
    });
    chart.timeScale().fitContent();
    new ResizeObserver(function () { chart.applyOptions({ width: body.clientWidth }); }).observe(body);
    chart.applyOptions({ width: body.clientWidth });
  }

  function renderNavView() {
    currentId = null;
    currentView = "nav";
    syncSidebarActive();
    closeDrawer();
    $list.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $docsList.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });

    const last = NAV_DATA[NAV_DATA.length - 1];
    const peak = Math.max.apply(null, NAV_DATA.map(function (d) { return d[1]; }));
    const peakItem = NAV_DATA.filter(function (d) { return d[1] === peak; })[0] || ["-", 0];
    const dd = (last[1] - peak) / peak * 100;           // 距峰值回撤
    const vsBase = (last[1] / 100 - 1) * 100;           // 距基准 100
    const ddOk = dd >= -4;

    let html = '<div class="summary-page">';
    html += renderViewTabs("nav");
    html += '<div class="sp-header"><h2>📈 净值</h2><span class="sp-period">控制回撤 · 保住利润</span></div>';
    html += '<div class="nav-stats">';
    html += '<div class="ns-item"><span class="ns-label">最新净值</span><b>' + last[1].toFixed(1) + "</b><em>" + last[0].slice(5).replace("-", "/") + "</em></div>";
    html += '<div class="ns-item"><span class="ns-label">距基准 100</span><b class="' + (vsBase >= 0 ? "up" : "down") + '">' + (vsBase >= 0 ? "+" : "") + vsBase.toFixed(1) + "%</b></div>";
    html += '<div class="ns-item"><span class="ns-label">距峰值 ' + peak.toFixed(1) + "（" + peakItem[0].slice(5).replace("-", "/") + "）</span><b class=\"" + (dd >= 0 ? "up" : "down") + '">' + (dd >= 0 ? "+" : "") + dd.toFixed(1) + "%</b></div>";
    html += '<div class="ns-item"><span class="ns-label">4% 回撤纪律</span><b class="' + (ddOk ? "up" : "down") + '">' + (ddOk ? "✅ 在线内" : "⚠️ 已超线") + "</b></div>";
    html += "</div>";
    html += '<div class="mode-card"><div class="pc-title">📊 组合净值曲线<span class="pc-hint">（橙色虚线 = 基准 100）</span></div><div class="pc-body pc-nav" id="navChartBody"><div class="loading">净值加载中…</div></div></div>';
    html += "</div>";
    $main.innerHTML = html;
    bindVtabs(); // 先绑事件再画图：图表异常也不能让 tab 失效
    drawNavChart();
    window.scrollTo({ top: 0 });
  }

  // ---------- 精选页（栏目切换 + 组合决策） ----------
  function latestReportOf(ticker) {
    const reps = REPORTS.filter(function (r) { return r.ticker === ticker; })
      .sort(function (a, b) { return b.stamp.localeCompare(a.stamp); });
    return reps[0] || null;
  }

  function renderFeatured(ticker) {
    if (!FEATURED.some(function (f) { return f.ticker === ticker; })) ticker = FEATURED[0].ticker;
    currentId = ticker;
    currentView = "featured";
    syncSidebarActive();
    closeDrawer();
    $list.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $docsList.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });

    let html = '<div class="summary-page">';
    html += '<div class="sp-header"><h2>⭐ 精选组合</h2><span class="sp-period">精选标的 · 组合决策</span></div>';
    html += '<div class="tabs ftabs">';
    FEATURED.forEach(function (f) {
      html += '<button class="tab' + (f.ticker === ticker ? " active" : "") + '" data-ft="' + esc(f.ticker) + '">' + esc(f.label) + "</button>";
    });
    html += "</div>";

    const r = latestReportOf(ticker);
    if (!r) {
      html += '<div class="placeholder"><div class="placeholder-icon">📭</div><p>暂无 ' + esc(ticker) + " 的分析报告</p></div></div>";
      $main.innerHTML = html;
      bindFtabs(ticker);
      return;
    }

    const fLabel = (FEATURED.find(function (f) { return f.ticker === ticker; }) || {}).label || "";
    html += '<div class="report-header">' +
      '<div class="rh-line1"><h2>' + esc(fLabel) + "</h2>" +
      '<span class="rh-name">' + esc(r.ticker) + " · " + esc(r.name || "") + "</span>" +
      '<span class="badge ' + ratingClass(r.rating) + '" style="font-size:14px;">' + esc(r.rating || "未评级") + "</span></div>" +
      '<div class="rh-meta">' +
      "<span>分析日期 <b>" + esc(r.date || "—") + "</b></span>" +
      (r.target ? "<span>目标价 <b>" + esc(r.target) + "</b></span>" : "") +
      (r.horizon ? "<span>期限 <b>" + esc(r.horizon) + "</b></span>" : "") +
      "<span>生成时间 <b>" + esc(r.generated || r.stamp) + "</b></span>" +
      "</div>" +
      (r.summary ? '<div class="report-summary">' + esc(r.summary) + "</div>" : "") +
      "</div>";
    html += '<div class="content no-tabs" id="content"><div class="loading">组合决策加载中…</div></div>';
    html += "</div>";

    $main.innerHTML = html;
    bindFtabs(ticker);

    // 执行计划 K 线图（挂载点：栏目 tabs 之后）
    if (r.aux) {
      const tabsEl = $main.querySelector(".ftabs");
      if (tabsEl) mountPlanChart(r, tabsEl);
    }

    // 组合决策正文
    let dpath = r.files && r.files.decision;
    if (Array.isArray(dpath)) dpath = dpath.length ? dpath[0].path : null;
    if (dpath) loadMd(r, dpath);
    else {
      const c = document.getElementById("content");
      if (c) c.innerHTML = '<div class="loading">暂无组合决策内容</div>';
    }
    window.scrollTo({ top: 0 });
  }

  function bindFtabs(cur) {
    $main.querySelectorAll(".ftabs .tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.ft !== cur) navigate("featured", btn.dataset.ft);
      });
    });
  }

  // ---------- 专题报告（侧栏菜单 + 内嵌展示） ----------
  function renderSpecials() {
    if (!SPECIALS.length) {
      $specialList.innerHTML = "";
      return;
    }
    // 按日期倒序，最新的在最上面
    const sorted = SPECIALS.slice().sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
    let html = "";
    sorted.forEach(function (sp) {
      html += '<div class="tree-report' + (currentView === "special" && currentId === sp.id ? " active" : "") + '" data-id="' + esc(sp.id) + '">' +
        '<span class="badge k-special">' + esc(sp.kind || "专题") + "</span>" +
        '<span class="tr-doc-title">' + esc(sp.title) + "</span>" +
        "</div>";
    });
    $specialList.innerHTML = html;
  }

  function renderSpecial(sp) {
    currentId = sp.id;
    currentView = "special";
    syncSidebarActive();
    closeDrawer();
    renderSpecials();
    $list.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $docsList.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $main.innerHTML =
      '<div class="report-header">' +
      '<div class="rh-line1"><span class="badge k-special" style="font-size:13px;">' + esc(sp.kind || "专题") + "</span>" +
      '<h2 style="font-family:inherit;">' + esc(sp.title) + "</h2></div>" +
      '<div class="rh-meta"><span>日期 <b>' + esc(sp.date || "—") + "</b></span></div>" +
      (sp.desc ? '<div class="report-summary">' + esc(sp.desc) + "</div>" : "") +
      "</div>" +
      '<div class="special-frame"><iframe src="' + esc(sp.file) + '" title="' + esc(sp.title) + '" loading="lazy"></iframe></div>';
    window.scrollTo({ top: 0 });
  }

  $specialList.addEventListener("click", function (e) {
    const item = e.target.closest(".tree-report");
    if (item) navigate("special", item.dataset.id);
  });

  // ---------- 教程（侧栏两级菜单 + 内嵌展示） ----------
  function allTutorials() {
    let out = [];
    (TUTORIAL_GROUPS || []).forEach(function (g) {
      (g.items || []).forEach(function (t) { out.push(t); });
    });
    return out;
  }
  function findTutorial(id) {
    const hit = allTutorials().find(function (t) { return t.id === id; });
    return hit || null;
  }

  function renderTutorials() {
    if (!TUTORIAL_GROUPS.length) {
      $tutorialsList.innerHTML = "";
      return;
    }
    let html = "";
    TUTORIAL_GROUPS.forEach(function (g) {
      html += '<div class="tree-group">' + esc(g.name || "教程") + "</div>";
      (g.items || []).forEach(function (t) {
        html += '<div class="tree-report sub' + (currentView === "tutorial" && currentId === t.id ? " active" : "") + '" data-id="' + esc(t.id) + '">' +
          '<span class="badge k-tutorial">' + esc(t.kind || "教程") + "</span>" +
          '<span class="tr-doc-title">' + esc(t.title) + "</span>" +
          "</div>";
      });
    });
    $tutorialsList.innerHTML = html;
  }

  function renderTutorial(t) {
    currentId = t.id;
    currentView = "tutorial";
    syncSidebarActive();
    closeDrawer();
    renderTutorials();
    $list.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $docsList.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $specialList.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $main.innerHTML =
      '<div class="special-frame tutorial-frame"><iframe src="' + esc(t.file) + '" title="' + esc(t.title) + '" loading="lazy"></iframe></div>';
    window.scrollTo({ top: 0 });
  }

  $tutorialsList.addEventListener("click", function (e) {
    const item = e.target.closest(".tree-report");
    if (item) navigate("tutorial", item.dataset.id);
  });

  // ---------- 日期筛选 ----------
  function daysAgoISO(n) {
    const d = new Date(Date.now() - n * 86400000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // 默认日期：当天有数据用当天，否则取最近一个有数据的日期（都没有则回退全部日期）
  function defaultDate() {
    const set = new Set();
    REPORTS.forEach(function (r) { if (r.date && r.date.length >= 10) set.add(r.date.slice(0, 10)); });
    TDOCS.forEach(function (d) { if (d.date && d.date.length >= 10) set.add(d.date.slice(0, 10)); });
    if (!set.size) return "";
    const today = daysAgoISO(0);
    if (set.has(today)) return today;
    return Array.from(set).sort().pop() || "";
  }

  function matchDate(dateStr) {
    if (!dateFilter) return true;
    if (!dateStr || dateStr.length < 10) return false;
    const ds = dateStr.slice(0, 10);
    if (dateFilter === "7d") return ds >= daysAgoISO(7);
    if (dateFilter === "30d") return ds >= daysAgoISO(30);
    return ds === dateFilter; // 具体某天
  }

  // 根据数据动态填充具体日期选项（保留当前选中值）
  function populateDateOptions() {
    const set = new Set();
    REPORTS.forEach(function (r) { if (r.date && r.date.length >= 10) set.add(r.date.slice(0, 10)); });
    TDOCS.forEach(function (d) { if (d.date && d.date.length >= 10) set.add(d.date.slice(0, 10)); });
    const dates = Array.from(set).sort().reverse();
    const cur = dateFilter;
    // 清掉旧的具体日期选项（保留前三个固定项）
    Array.from($date.options).forEach(function (opt) {
      if (opt.value !== "" && opt.value !== "7d" && opt.value !== "30d") opt.remove();
    });
    dates.forEach(function (ds) {
      const opt = document.createElement("option");
      opt.value = ds;
      opt.textContent = ds;
      $date.appendChild(opt);
    });
    $date.value = cur;
  }

  // ---------- 每日报告文档（腾讯文档/本地收录） ----------
  function kindClass(kind) {
    if (kind === "Finance 报告") return "k-fin";
    if (kind === "股票池扫描") return "k-scan";
    if (kind === "ETF 技术分析") return "k-etf";
    return "k-other";
  }

  function visibleDocs() {
    if (dateFilter) return visibleDocsBase().filter(function (d) { return matchDate(d.date); });
    return visibleDocsBase();
  }

  function visibleDocsBase() {
    if (!keyword) return TDOCS;
    return TDOCS.filter(function (d) {
      return (d.title + " " + d.kind + " " + d.date).toLowerCase().indexOf(keyword) !== -1;
    });
  }

  function renderDocs() {
    const docs = visibleDocs();
    if (!docs.length) {
      $docsList.innerHTML = '<div class="tree-empty">暂无文档' + (keyword ? "匹配" : "") + "</div>";
      return;
    }
    // 按日期分组（json 已按日期倒序）
    const groups = [];
    docs.forEach(function (d) {
      const key = d.date || "未知日期";
      let g = groups.find(function (x) { return x.date === key; });
      if (!g) { g = { date: key, items: [] }; groups.push(g); }
      g.items.push(d);
    });
    // 默认只展示最近 1 天（搜索时全部显示），点「更多」展开其余
    const searching = !!keyword;
    const shown = (showAllDocs || searching) ? groups : groups.slice(0, 1);
    let html = "";
    shown.forEach(function (g) {
      const isOpen = expandedDates[g.date] !== false;
      html += '<div class="tree-stock' + (isOpen ? " open" : "") + '">';
      html += '<div class="tree-stock-head doc-date-head" data-date="' + esc(g.date) + '">' +
        '<span class="ts-arrow">▸</span>' +
        '<span class="ts-body"><span class="ts-name">' + esc(g.date) + "</span>" +
        '<span class="ts-code">' + g.items.length + " 篇</span></span></div>";
      html += '<div class="tree-reports">';
      g.items.forEach(function (d) {
        html += '<div class="tree-report' + (currentView === "doc" && currentId === d.id ? " active" : "") + '" data-id="' + esc(d.id) + '">' +
          '<span class="badge ' + kindClass(d.kind) + '">' + esc(d.kind) + "</span>" +
          '<span class="tr-doc-title">' + esc(d.title) + "</span>" +
          "</div>";
      });
      html += "</div></div>";
    });
    if (!showAllDocs && !searching && groups.length > 1) {
      html += '<div class="docs-more" id="docsMore">更多日期（' + (groups.length - 1) + " 天）▾</div>";
    } else if (showAllDocs && !searching && groups.length > 1) {
      html += '<div class="docs-more" id="docsMore">收起 ↑</div>';
    }
    $docsList.innerHTML = html;
  }

  function renderDoc(doc) {
    currentId = doc.id;
    currentView = "doc";
    syncSidebarActive();
    closeDrawer();
    renderDocs();
    $list.querySelectorAll(".tree-report.active").forEach(function (el) { el.classList.remove("active"); });
    $main.innerHTML =
      '<div class="report-header">' +
      '<div class="rh-line1"><span class="badge ' + kindClass(doc.kind) + '" style="font-size:13px;">' + esc(doc.kind) + "</span>" +
      '<h2 style="font-family:inherit;">' + esc(doc.title) + "</h2></div>" +
      '<div class="rh-meta">' +
      "<span>日期 <b>" + esc(doc.date || "—") + "</b></span>" +
      (doc.url ? '<span>原文 <a href="' + esc(doc.url) + '" target="_blank" rel="noopener">腾讯文档 ↗</a></span>' : "") +
      "</div></div>" +
      '<div class="content no-tabs" id="content"><div class="loading">加载中…</div></div>';
    loadMdRaw(doc.path);
  }

  function loadMdRaw(relPath) {
    const $content = document.getElementById("content");
    if (!$content) return;
    if (currentAbort) currentAbort.abort();
    currentAbort = new AbortController();
    $content.innerHTML = '<div class="loading">加载中…</div>';
    $content.classList.add("loading");
    fetch(relPath.split("/").map(encodeURIComponent).join("/"), { signal: currentAbort.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        $content.classList.remove("loading");
        $content.innerHTML = '<div class="md">' + marked.parse(text) + "</div>";
      })
      .catch(function (err) {
        if (err.name === "AbortError") return;
        $content.classList.remove("loading");
        $content.innerHTML = '<div class="loading">加载失败: ' + esc(err.message) + "</div>";
      });
  }

  $docsList.addEventListener("click", function (e) {
    if (e.target.closest("#docsMore")) {
      showAllDocs = !showAllDocs;
      renderDocs();
      return;
    }
    const item = e.target.closest(".tree-report");
    if (item) {
      navigate("doc", item.dataset.id);
      return;
    }
    const head = e.target.closest(".doc-date-head");
    if (head) {
      const d = head.dataset.date;
      expandedDates[d] = expandedDates[d] === false ? true : false;
      renderDocs();
    }
  });

  // ---------- 树形报告列表 ----------
  function visibleReports() {
    return REPORTS.filter(function (r) {
      if (ratingFilter && (r.rating || "").indexOf(ratingFilter) === -1) return false;
      if (!matchDate(r.date)) return false;
      if (!keyword) return true;
      const hay = (r.ticker + " " + r.name + " " + r.rating + " " + r.date + " " + (r.summary || "")).toLowerCase();
      return hay.indexOf(keyword) !== -1;
    });
  }

  function buildGroups() {
    const map = new Map();
    visibleReports().forEach(function (r) {
      if (!map.has(r.ticker)) map.set(r.ticker, []);
      map.get(r.ticker).push(r);
    });
    const groups = [];
    map.forEach(function (reports, ticker) {
      reports.sort(function (a, b) { return b.stamp.localeCompare(a.stamp); });
      const top = reports[0];
      groups.push({ ticker: ticker, name: top.name || "", reports: reports,
        // 先按最新报告日期倒序，同日内按评级优先级倒序，再按时间戳倒序
        sortKey: (top.date || "").slice(0, 10) + String(100 + ratingRank(top.rating)) + top.stamp });
    });
    groups.sort(function (a, b) { return b.sortKey.localeCompare(a.sortKey); });
    return groups;
  }

  function fmtStamp(stamp) {
    if (!stamp || stamp.length < 15) return stamp || "";
    return stamp.slice(4, 6) + "-" + stamp.slice(6, 8) + " " + stamp.slice(9, 11) + ":" + stamp.slice(11, 13);
  }

  function renderTree() {
    const groups = buildGroups();
    if (!groups.length) {
      $list.innerHTML = '<div class="tree-empty">没有匹配的报告</div>';
      return;
    }
    let html = "";
    groups.forEach(function (g) {
      const isOpen = expanded[g.ticker] !== false;
      html += '<div class="tree-stock' + (isOpen ? " open" : "") + '">';
      html += '<div class="tree-stock-head" data-ticker="' + esc(g.ticker) + '">' +
        '<span class="ts-arrow">▸</span>' +
        '<span class="ts-body"><span class="ts-name">' + esc(g.name || g.ticker) + "</span>" +
        '<span class="ts-code mono">' + esc(g.ticker) + " · " + g.reports.length + " 份</span></span>" +
        '<span class="badge ' + ratingClass(g.reports[0].rating) + '">' + esc(g.reports[0].rating || "—") + "</span>" +
        "</div>";
      html += '<div class="tree-reports">';
      g.reports.forEach(function (r) {
        html += '<div class="tree-report' + (r.id === currentId ? " active" : "") + '" data-id="' + esc(r.id) + '">' +
          '<span class="tr-date">' + esc(r.date || fmtStamp(r.stamp)) + "</span>" +
          '<span class="tr-time">' + esc(fmtStamp(r.stamp)) + "</span>" +
          '<span class="badge ' + ratingClass(r.rating) + '">' + esc(r.rating || "—") + "</span>" +
          (r.target ? '<span class="tr-target">目标 ' + esc(r.target) + "</span>" : "") +
          "</div>";
      });
      html += "</div></div>";
    });
    $list.innerHTML = html;
  }

  // ---------- 详情 ----------
  function findReport(id) {
    return REPORTS.find(function (r) { return r.id === id; });
  }

  function renderDetail(r) {
    const cls = ratingClass(r.rating);
    let html = '<div class="report-header">' +
      '<div class="rh-line1"><h2>' + esc(r.ticker) + "</h2>" +
      '<span class="rh-name">' + esc(r.name || "") + "</span>" +
      '<span class="badge ' + cls + '" style="font-size:14px;">' + esc(r.rating || "未评级") + "</span></div>" +
      '<div class="rh-meta">' +
      "<span>分析日期 <b>" + esc(r.date || "—") + "</b></span>" +
      (r.target ? "<span>目标价 <b>" + esc(r.target) + "</b></span>" : "") +
      (r.horizon ? "<span>期限 <b>" + esc(r.horizon) + "</b></span>" : "") +
      "<span>生成时间 <b>" + esc(r.generated || r.stamp) + "</b></span>" +
      "</div>" +
      (r.summary ? '<div class="report-summary">' + esc(r.summary) + "</div>" : "") +
      "</div>";

    const tabs = [];
    if (r.files.complete) tabs.push(["complete", "完整报告"]);
    Object.keys(r.files).forEach(function (k) {
      if (k === "complete") return;
      const names = { analysts: "分析师团队", research: "研究辩论", trading: "交易计划", risk: "风险讨论", decision: "组合决策" };
      tabs.push([k, names[k] || k]);
    });

    html += '<div class="tabs">';
    // 默认打开"组合决策"(有 K 线图解和最终决策), 没有则退回第一个 tab
    const firstSec = (tabs.find(function (t) { return t[0] === "decision"; }) || tabs[0])[0];
    tabs.forEach(function (t) {
      html += '<button class="tab' + (t[0] === firstSec ? " active" : "") + '" data-sec="' + esc(t[0]) + '">' + esc(t[1]) + "</button>";
    });
    html += "</div>";

    if (firstSec !== "complete" && Array.isArray(r.files[firstSec])) {
      html += '<div class="subtabs" id="subtabs"></div>';
    }
    html += '<div class="content" id="content"><div class="loading">加载中…</div></div>';

    $main.innerHTML = html;
    $main.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () { switchSection(r, btn.dataset.sec); });
    });
    switchSection(r, firstSec);
  }

  let currentAbort = null;

  function switchSection(report, secKey) {
    $main.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.sec === secKey);
    });

    // 决策页：先渲染执行计划 K 线图容器（在 md 内容加载前挂好，避免竞态）
    const oldChart = document.getElementById("planChart");
    if (oldChart) oldChart.remove();
    if (secKey === "decision" && report.aux) {
      const tabsEl = $main.querySelector(".tabs");
      if (tabsEl) mountPlanChart(report, tabsEl);
    }

    const files = report.files[secKey] || [];
    const isList = Array.isArray(files);

    let subWrap = document.getElementById("subtabs");
    if (isList) {
      if (!subWrap) {
        subWrap = document.createElement("div");
        subWrap.className = "subtabs";
        subWrap.id = "subtabs";
        $main.querySelector(".tabs").after(subWrap);
      }
      subWrap.style.display = "flex";
      subWrap.innerHTML = files.map(function (f, i) {
        return '<button class="subtab' + (i === 0 ? " active" : "") + '" data-path="' + esc(f.path) + '">' + esc(f.label) + "</button>";
      }).join("");
      subWrap.querySelectorAll(".subtab").forEach(function (btn) {
        btn.addEventListener("click", function () {
          subWrap.querySelectorAll(".subtab").forEach(function (b) { b.classList.remove("active"); });
          btn.classList.add("active");
          loadMd(report, btn.dataset.path);
        });
      });
      loadMd(report, files[0].path);
    } else {
      if (subWrap) subWrap.style.display = "none";
      loadMd(report, files.path);
    }
  }

  const PC_COLORS = { entry: "#e03131", trim: "#f76707", stop: "#2f9e44", clear: "#087f5b", target: "#1971c2", trigger: "#9c36b5", avoid: "#868e96" };

  // 在 anchor 元素之后挂载执行计划 K 线图（报告详情页与精选页共用）
  function mountPlanChart(report, anchor) {
    if (!anchor) return;
    const wrap = document.createElement("div");
    wrap.className = "plan-chart";
    wrap.id = "planChart";
    wrap.innerHTML = '<div class="pc-title">📊 执行计划 · K线图解<span class="pc-hint">（可拖拽缩放）</span></div>' +
      '<div class="pc-legend">' +
      '<span class="pc-chip" style="color:#e03131;">■ 建仓</span>' +
      '<span class="pc-chip" style="color:#f76707;">■ 减仓</span>' +
      '<span class="pc-chip" style="color:#2f9e44;">■ 止损/清仓</span>' +
      '<span class="pc-chip" style="color:#1971c2;">■ 目标</span>' +
      '<span class="pc-chip" style="color:#9c36b5;">■ 触发</span>' +
      "</div>" +
      '<div class="pc-body"><div class="loading">K线加载中…</div></div>';
    anchor.after(wrap);
    fetch(report.aux.split("/").map(encodeURIComponent).join("/"))
      .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
      .then(function (aux) { drawPlanChart(wrap, aux); })
      .catch(function () { wrap.remove(); });
  }

  function drawPlanChart(wrap, aux) {
    const body = wrap.querySelector(".pc-body");
    if (!window.LightweightCharts || !aux || !aux.candles || !aux.candles.length) {
      body.innerHTML = '<div class="pc-empty">暂无K线数据</div>';
      return;
    }
    body.innerHTML = ""; // 清掉"加载中"占位
    const isDark = document.body.classList.contains("dark");
    const textCol = isDark ? "#adb5bd" : "#495057";
    const isMobile = body.clientWidth < 640;
    const chart = LightweightCharts.createChart(body, {
      height: isMobile ? 280 : 340,
      layout: { background: { color: "transparent" }, textColor: textCol, fontSize: 11 },
      grid: { vertLines: { color: "rgba(128,134,139,.12)" }, horzLines: { color: "rgba(128,134,139,.12)" } },
      timeScale: { borderColor: "rgba(128,134,139,.25)", timeVisible: false },
      rightPriceScale: { borderColor: "rgba(128,134,139,.25)" },
      crosshair: { mode: 0 },
    });
    const series = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: "#e03131", downColor: "#2f9e44", borderVisible: false,
      wickUpColor: "#e03131", wickDownColor: "#2f9e44",
    });
    const data = aux.candles.map(function (c) {
      return { time: c[0], open: c[1], close: c[2], high: c[3], low: c[4] };
    });
    series.setData(data);

    const seenLabels = {};
    (aux.plan || []).forEach(function (lv) {
      const color = PC_COLORS[lv.type] || "#868e96";
      const prices = lv.price2 != null ? [lv.price, lv.price2] : [lv.price];
      prices.forEach(function (p, i) {
        let title = lv.label + (lv.price2 != null ? (i === 0 ? "·下沿" : "·上沿") : "");
        if (seenLabels[title]) return;
        seenLabels[title] = true;
        series.createPriceLine({
          price: p,
          color: color,
          lineWidth: 1,
          lineStyle: lv.price2 != null || lv.type === "trigger" ? 2 : 0,
          axisLabelVisible: true,
          title: title,
        });
      });
    });
    // 默认放大: 显示 16 天(手机 12 天), 倒数第 5 天居中, 最后一天右侧留空给执行计划标签
    // (仍可拖拽缩放)
    const lastIdx = data.length - 1;
    const span = isMobile ? 6 : 8;
    const centerIdx = Math.max(lastIdx - 4, span);
    chart.timeScale().setVisibleLogicalRange({ from: centerIdx - span, to: centerIdx + span });
    new ResizeObserver(function () {
      chart.applyOptions({ width: body.clientWidth });
    }).observe(body);
    chart.applyOptions({ width: body.clientWidth });
  }

  // 牛熊周期月线图（创业板指：静态 SVG，与"A股暴跌复盘"特别页同款风格——
  // 红区=熊市带（回撤%标在带内），大顶红字标记，选举/美联储事件虚线+下方错层标签）
  function drawCycleChart() {
    const body = document.getElementById("cycleChartBody");
    if (!body || !CYCLE_KLINE.length) return;
    const W = 880, H = 344, X0 = 60, X1 = 840, Y0 = 20, Y1 = 265;
    const n = CYCLE_KLINE.length;
    const xs = function (i) { return X0 + (X1 - X0) * i / (n - 1); };
    const vals = CYCLE_KLINE.map(function (m) { return parseFloat(m[1]); });
    const vMin = Math.min.apply(null, vals), vMax = Math.max.apply(null, vals);
    const step = Math.ceil((vMax - vMin) / 5 / 100) * 100;
    const base = Math.floor(vMin / 100) * 100;
    const ys = function (v) { return Y1 - (v - base) / (step * 5) * (Y1 - Y0); };
    const monthIdx = {};
    CYCLE_KLINE.forEach(function (m, i) { monthIdx[m[0]] = i; });

    let svg = '<svg viewBox="0 0 ' + W + " " + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%">';
    // 网格 + y 轴刻度
    for (let g = 0; g <= 5; g++) {
      const gv = base + g * step, gy = ys(gv);
      svg += '<line x1="' + X0 + '" y1="' + gy + '" x2="' + X1 + '" y2="' + gy + '" stroke="#e5e7eb" stroke-width="1"/>';
      svg += '<text x="' + (X0 - 6) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10" fill="#6b7280">' + gv + "</text>";
    }
    // 熊市阴影带 + 回撤%（窄带标签放带子右侧，避免挤压）
    const bandColor = function (dd) { return dd >= 55 ? "#fca5a5" : dd >= 40 ? "#fecaca" : "#fee2e2"; };
    const bandLabel = [
      { mode: "mid", y: 210 }, { mode: "right", y: 100 }, { mode: "mid", y: 215 },
      { mode: "right", y: 100 }, { mode: "mid", y: 140 }, { mode: "mid", y: 60 },
    ];
    BEAR_BANDS.forEach(function (b, i) {
      const i1 = monthIdx[b[0]], i2 = monthIdx[b[1]];
      if (i1 == null || i2 == null) return;
      const x1 = xs(i1), x2 = xs(i2);
      const dd = parseFloat(b[2].replace(/[^0-9.]/g, ""));
      svg += '<rect x="' + x1 + '" y="' + Y0 + '" width="' + Math.max(2, x2 - x1) + '" height="' + (Y1 - Y0) + '" fill="' + bandColor(dd) + '" opacity="0.55"/>';
      const L = bandLabel[i] || { mode: "mid", y: 200 };
      if (L.mode === "right") {
        svg += '<text x="' + (x2 + 12) + '" y="' + L.y + '" text-anchor="start" font-size="10" fill="#b91c1c" font-weight="bold">' + b[2] + "</text>";
      } else {
        svg += '<text x="' + ((x1 + x2) / 2) + '" y="' + L.y + '" text-anchor="middle" font-size="10" fill="#b91c1c" font-weight="bold">' + b[2] + "</text>";
      }
    });
    // 事件虚线（先画线，价格线压在上面）
    const evColor = { fed: "#f08c00", dem: "#1971c2", rep: "#e03131" };
    const evText = { fed: "#b56500", dem: "#1971c2", rep: "#e03131" };
    CYCLE_EVENTS.forEach(function (e) {
      const i = monthIdx[e.t];
      if (i == null) return;
      const ex = xs(i), col = evColor[e.c] || "#999", ty = 306 + e.lvl * 13;
      svg += '<g><title>' + esc(e.t + " " + e.d) + "</title>";
      svg += '<line x1="' + ex + '" y1="' + Y0 + '" x2="' + ex + '" y2="' + (ty - 10) + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>';
      svg += '<text x="' + (ex > 800 ? ex + 4 : ex) + '" y="' + ty + '" text-anchor="' + (ex > 800 ? "end" : "middle") + '" font-size="10" font-weight="600" fill="' + evText[e.c] + '">' + esc(e.s) + "</text></g>";
    });
    // 价格线
    const pts = CYCLE_KLINE.map(function (m, i) { return xs(i).toFixed(1) + "," + ys(parseFloat(m[1])).toFixed(1); }).join(" ");
    svg += '<polyline points="' + pts + '" fill="none" stroke="#2563eb" stroke-width="1.5"/>';
    // 大顶标记
    [["2015-06", "大顶 4038"], ["2021-07", "大顶 3576 (+6.1年)"], ["2026-06", "大顶 4380 (+4.9年)"]].forEach(function (p) {
      const i = monthIdx[p[0]];
      if (i == null) return;
      svg += '<text x="' + xs(i) + '" y="' + Math.max(14, ys(vals[i]) - 10) + '" text-anchor="middle" font-size="10" fill="#b91c1c" font-weight="bold">' + p[1] + "</text>";
    });
    // 末值
    svg += '<text x="' + (X1 + 4) + '" y="' + (ys(vals[n - 1]) + 4) + '" font-size="10" fill="#2563eb" font-weight="bold">' + Math.round(vals[n - 1]) + "</text>";
    // 年份轴（每年 1 月）
    CYCLE_KLINE.forEach(function (m, i) {
      if (m[0].slice(5) === "01") svg += '<text x="' + xs(i) + '" y="292" text-anchor="middle" font-size="10" fill="#6b7280">' + m[0].slice(0, 4) + "</text>";
    });
    svg += "</svg>";
    body.innerHTML = svg;
  }

  function loadMd(report, relPath) {
    const $content = document.getElementById("content");
    if (!$content) return;
    if (currentAbort) currentAbort.abort();
    currentAbort = new AbortController();
    $content.innerHTML = '<div class="loading">加载中…</div>';
    $content.classList.add("loading");
    fetch("reports/" + encodeURIComponent(report.id) + "/" + relPath.split("/").map(encodeURIComponent).join("/"), {
      signal: currentAbort.signal
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        $content.classList.remove("loading");
        $content.innerHTML = '<div class="md">' + marked.parse(text) + "</div>";
        $content.scrollTop = 0;
      })
      .catch(function (err) {
        if (err.name === "AbortError") return;
        $content.classList.remove("loading");
        $content.innerHTML = '<div class="loading">加载失败: ' + esc(err.message) + "</div>";
      });
  }

  function renderReport(id) {
    const r = findReport(id);
    if (!r) return;
    currentId = id;
    currentView = "report";
    expanded[r.ticker] = true;
    syncSidebarActive();
    closeDrawer();
    renderTree();
    renderDetail(r);
    window.scrollTo({ top: 0 });
  }

  // ---------- 事件 ----------
  $summaryEntry.addEventListener("click", function () { navigate("summary"); });
  $featuredEntry.addEventListener("click", function () { navigate("featured", FEATURED[0].ticker); });

  $list.addEventListener("click", function (e) {
    const rep = e.target.closest(".tree-report");
    if (rep) { navigate("report", rep.dataset.id); return; }
    const head = e.target.closest(".tree-stock-head");
    if (head) {
      const t = head.dataset.ticker;
      expanded[t] = expanded[t] === false ? true : false;
      renderTree();
    }
  });

  let searchTimer = null;
  $search.addEventListener("input", function () {
    keyword = $search.value.trim().toLowerCase();
    keepDrawer = true; // 搜索过滤时保持抽屉打开
    renderTree();
    if (TDOCS.length) renderDocs();
    // 防抖后写入 hash（产生一条历史记录，回退可回到上一次筛选状态）
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { navigate(currentView, currentId); }, 500);
  });

  $rating.addEventListener("change", function () {
    keepDrawer = true; // 筛选时保持抽屉打开
    ratingFilter = $rating.value;
    renderTree();
    navigate(currentView, currentId);
  });

  $date.addEventListener("change", function () {
    keepDrawer = true; // 筛选时保持抽屉打开
    dateFilter = $date.value;
    renderTree();
    if (TDOCS.length) renderDocs();
    navigate(currentView, currentId);
  });

  // ---------- 初始化 ----------
  fetch("data/reports.json")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      REPORTS = data.reports || [];
      BRIEF = data.brief || null;
      STRATEGY = data.strategy || [];
      $subtitle.textContent = "共 " + data.count + " 份报告 · 数据更新于 " + (data.generatedAt || "—").replace("T", " ");
      populateDateOptions();
      renderTree();
      applyHash(); // 按当前 hash 渲染（默认总结页，支持带状态的书签/回退）
      // 每日报告文档（独立模块，加载失败不影响主报告）
      return fetch("data/tdocs.json").then(function (res) { return res.json(); });
    })
    .then(function (tdata) {
      if (!tdata) return;
      TDOCS = tdata.docs || [];
      populateDateOptions();
      renderDocs();
      // 若初始 hash 指向某篇文档（当时 tdocs 尚未加载），补渲染
      const st = parseHash();
      if (st.view === "doc") applyHash();
    })
    .then(function () {
      // 专题报告（独立模块，加载失败不影响主报告）
      return fetch("data/special.json").then(function (res) { return res.json(); });
    })
    .then(function (sdata) {
      if (!sdata) return;
      SPECIALS = sdata.reports || [];
      renderSpecials();
      // 总结页可能在 SPECIALS 加载前已渲染（跳转链接缺失），补渲染
      if (currentView === "summary") renderSummaryView();
      // 若初始 hash 指向某个专题（当时 special 尚未加载），补渲染
      const st = parseHash();
      if (st.view === "special") applyHash();
    })
    .then(function () {
      // 教程（独立模块，加载失败不影响主报告）
      return fetch("data/tutorials.json").then(function (res) { return res.json(); });
    })
    .then(function (tutData) {
      if (!tutData) return;
      TUTORIAL_GROUPS = tutData.groups || [];
      renderTutorials();
      // 若初始 hash 指向某篇教程（当时 tutorials 尚未加载），补渲染
      const st = parseHash();
      if (st.view === "tutorial") applyHash();
    })
    .catch(function (err) {
      if (REPORTS.length) { renderDocs(); return; } // tdocs 失败但主报告正常
      $subtitle.textContent = "数据加载失败";
      $main.innerHTML = '<div class="placeholder"><div class="placeholder-icon">⚠️</div><p>reports.json 加载失败，请先运行 sync.py 同步数据</p></div>';
    });
})();
