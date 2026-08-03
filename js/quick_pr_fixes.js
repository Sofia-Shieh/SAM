/**
 * quick_pr_fixes.js —— 「自动提需求单」（原快速生成 PR）走 Neone PTP-MCP
 *
 * 职责边界（重要）：
 *   ● 蓝色「自动提需求单」：行内按钮(data-quick-pr) + 列表页(quick-pr tab) + 弹窗(quickPrModal)
 *     —— 全部走 Neone PTP-MCP：同源 POST /messages（JSON-RPC tools/call），工具 add_demand。
 *   ● 灰色「手动提需求单」：本模块【完全不接管】。由页面内联 openPrModal/submitPr 处理
 *     （识别 req → 自动填表 → 检查 → 提交，走后端 /api/submit_pr_form → pr_tool.py，不经 MCP）。
 *
 * 前提：
 *   1. 页面必须用 http://127.0.0.1:<端口>/board 打开（server.py 已把 /js 静态托管、/messages 接 oh-my-mcp）；
 *      双击 file:// 打开会让 /messages 变成 file:///…/messages 而失败。
 *   2. server.py 的 /messages 会把 {name:'add_demand', arguments:{…}} 转给 NeonePTP MCP，
 *      返回 {result:{content:[{type:'text',text:'<JSON字符串>'}]}}，JSON 里含 code / demand_code = 单号。
 *   3. 若 MCP 工具名/字段不同，改下方 MCP_TOOL / buildArgs 即可。
 */
(function () {
  'use strict';

  // ── 配置：同源、可调 ─────────────────────────────────────────────
  var MCP_ENDPOINT = '/messages';       // 同源相对路径，随页面端口自动匹配
  var MCP_TOOL = 'add_demand';          // NeonePTP MCP 的提单工具
  var DEFAULT_APPLICANT = 'yuqing.xie02';

  // ── 小工具 ───────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function getRows() {
    return (typeof state !== 'undefined' && state.snapshot && state.snapshot.rows) || [];
  }
  function findRowByReq(reqCode) {
    return getRows().find(function (r) { return r.sourceDocCode === reqCode; }) || null;
  }
  function pendingRows() {
    return getRows().filter(function (r) { return !r.prCode; });
  }

  // ── MCP 调用（同源 /messages，AbortController 30s 超时）────────────
  function mcpCall(tool, args) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);
    var payload = { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args || {} } };
    console.log('[MCP] call', tool, args);
    return fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).then(function (resp) {
      clearTimeout(timer);
      if (!resp.ok) {
        return resp.json().catch(function () { return null; }).then(function (j) {
          var m = j && j.error && j.error.message;
          throw new Error('MCP 返回 HTTP ' + resp.status + (m ? '：' + m : '') +
            '（确认已用 http://…/board 打开，且 server.py 的 /messages 已接 oh-my-mcp）');
        });
      }
      return resp.json();
    }).then(function (data) {
      console.log('[MCP] result', data);
      if (data.error) throw new Error('MCP 错误：' + (data.error.message || JSON.stringify(data.error)));
      var r = data.result;
      if (r && r.isError) {
        var et = (Array.isArray(r.content) && r.content[0] && r.content[0].text) || '';
        throw new Error('MCP 工具执行失败：' + (et || '未知错误'));
      }
      if (r && Array.isArray(r.content) && r.content[0] && r.content[0].type === 'text') {
        try { return JSON.parse(r.content[0].text); } catch (e) { return { raw: r.content[0].text }; }
      }
      return r || data;
    }).catch(function (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('MCP 调用超时（30s），请检查 server.py / oh-my-mcp');
      throw e;
    });
  }

  function extractPrCode(res) {
    if (!res) return '';
    return res.code || res.pr_code || res.prCode || res.demand_code || res.demandCode ||
      (res.data && (res.data.code || res.data.pr_code || res.data.demand_code)) || '';
  }

  // 组装 MCP add_demand 参数（对齐 server.py /api/neone/add_demand 文档字段）
  function buildArgs(row, opts) {
    opts = opts || {};
    var months = parseInt(opts.months, 10) || 1;
    var sw = (opts.softwareName || row.skuName || '').trim();
    var price = (opts.unitPrice != null && opts.unitPrice !== '')
      ? String(opts.unitPrice)
      : String(row.unitPrice || row.sw_unit_price || '').replace(/[^\d.]/g, '');
    var reason = (typeof buildPrReason === 'function') ? buildPrReason(row, row._note || '') : ('申请使用 ' + sw);
    var benefit = (typeof buildPrBenefit === 'function') ? buildPrBenefit(row, row._note || '') : ('获得 ' + sw + ' 的使用权');
    return {
      software_name: sw,
      applicant: opts.applicant || row.claimUserDomain || row.requesterDomain || DEFAULT_APPLICANT,
      department: (typeof getDeptDisplay === 'function' ? getDeptDisplay(row) : '') || row.requesterDepartment || '',
      currency: opts.currency || row.currency || 'CNY',
      quantity: 1,
      unit_price: price ? Number(price) : 0,
      months: months,
      description: reason,
      expected_effect: benefit,
      req_code: row.sourceDocCode || ''   // 便于后端/MCP 追溯，未用则忽略
    };
  }

  // 自动提需求单（MCP add_demand）
  function autoDemand(row, opts) {
    var sw = ((opts && opts.softwareName) || row.skuName || '').trim();
    if (!sw) return Promise.reject(new Error('软件名称不能为空'));
    return mcpCall(MCP_TOOL, buildArgs(row, opts)).then(function (res) {
      var pr = extractPrCode(res);
      if (!pr) {
        var m = (res && (res.error || res.message || res.raw)) || '未获取到 PR 单号';
        throw new Error(typeof m === 'string' ? m : JSON.stringify(m));
      }
      return { prCode: pr, simulated: !!(res && res.isSimulated) };
    });
  }

  // 对外暴露
  window.QuickPR = { autoDemand: autoDemand, tool: MCP_TOOL };

  function editUrl(prCode) {
    return 'https://neone.mihoyo.com/procurement/demand-edit/edit/' + prCode +
      '?hide_company_name=y&hide_expense_attribute_name=y';
  }

  // ══════════════ A. 弹窗（行内「自动提需求单」触发）══════════════
  var qprCurrentRow = null;

  function openModal(row) {
    qprCurrentRow = row;
    $('qprSoftwareName').textContent = (row.skuName || '--') + (row.version ? ' ' + row.version : '');
    $('qprApplicant').textContent = row.claimUserName || row.requesterName || '--';
    $('qprCurrency').textContent = row.currency || 'CNY';
    $('qprPrice').textContent = row.unitPrice ? (row.unitPrice + ' ' + (row.currency || '')).trim() : '待查询';
    $('qprMonths').value = '1';
    $('qprPreviewArea').innerHTML = '';
    $('qprStatus').style.display = 'none';
    $('qprCreateBtn').style.display = 'none';
    if ($('qprSubmitBtn')) $('qprSubmitBtn').style.display = 'none'; // 自动流只有 add_demand 一步
    $('quickPrModal').classList.add('open');
  }
  function qprStatus(text, isError) {
    var el = $('qprStatus');
    el.textContent = (isError ? '❌ ' : '') + text;
    el.style.display = 'block';
    el.style.color = isError ? 'var(--red)' : 'var(--text-3)';
  }

  function qprGenerate() {
    if (!qprCurrentRow) return;
    var createBtn = $('qprCreateBtn');
    createBtn.disabled = true;
    qprStatus('⏳ 正在经 MCP 自动提需求单…', false);
    var months = parseInt($('qprMonths').value, 10) || 1;
    autoDemand(qprCurrentRow, { months: months })
      .then(function (r) {
        $('qprPreviewArea').innerHTML =
          '<div style="background:var(--green-light);border:1px solid rgba(17,148,99,0.2);border-radius:var(--r10);padding:12px;">' +
          '<div style="color:var(--green);font-weight:600;margin-bottom:4px;">✅ 已自动提需求单</div>' +
          '<div style="font-size:12px;color:var(--text-2);line-height:1.7;"><strong>PR 单号：</strong>' + esc(r.prCode) + '<br>' +
          (r.simulated ? '<strong style="color:var(--orange);">⚠️ 模拟模式（MCP 未连真实后端）</strong><br>' : '') +
          '<a href="' + editUrl(r.prCode) + '" target="_blank" style="color:var(--primary);text-decoration:underline;">打开 Neone 查看</a></div></div>';
        qprStatus('✅ 成功：' + r.prCode, false);
      })
      .catch(function (err) { qprStatus('失败：' + err.message, true); console.error('[autoDemand] modal', err); })
      .then(function () { createBtn.disabled = false; });
  }

  // ══════════════ B. 列表页（批量）══════════════
  var selected = new Set();

  function filteredRows() {
    var reqKw = ($('quickPrSearchReq') && $('quickPrSearchReq').value.trim().toLowerCase()) || '';
    var swKw = ($('quickPrSearchSoftware') && $('quickPrSearchSoftware').value.trim().toLowerCase()) || '';
    return pendingRows().filter(function (r) {
      var okReq = !reqKw || (r.sourceDocCode || '').toLowerCase().indexOf(reqKw) >= 0;
      var okSw = !swKw || (r.skuName || '').toLowerCase().indexOf(swKw) >= 0;
      return okReq && okSw;
    });
  }

  function renderTable() {
    var tbody = $('quickPrTableBody');
    if (!tbody) return;
    var rows = filteredRows();
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-3);">' +
        '暂无待提单条目（已过滤掉已有 PR 的行）。请先在「今日待办」拉取最新数据。</td></tr>';
    } else {
      tbody.innerHTML = rows.map(function (r) {
        var req = esc(r.sourceDocCode);
        var checked = selected.has(r.sourceDocCode) ? 'checked' : '';
        var dept = esc(r.requesterDepartment || (r.requesterDepartmentFull || '').split('>').slice(-1)[0] || '');
        return '<tr style="border-bottom:1px solid var(--border);">' +
          '<td style="padding:8px 9px;text-align:center;"><input type="checkbox" data-qpr-check="' + req + '" ' + checked + ' /></td>' +
          '<td style="padding:8px 12px;font-family:var(--mono);color:var(--text-2);">' + req + '</td>' +
          '<td style="padding:8px 12px;font-weight:600;color:var(--text-1);">' + esc(r.skuName) +
          (r.version ? ' <span style="color:var(--text-3);font-weight:400;">' + esc(r.version) + '</span>' : '') + '</td>' +
          '<td style="padding:8px 12px;color:var(--text-2);">' + esc(r.claimUserName || r.requesterName) + '</td>' +
          '<td style="padding:8px 12px;color:var(--text-3);">' + dept + '</td>' +
          '<td style="padding:8px 12px;color:var(--text-2);">' + esc(r.currency || 'CNY') + '</td>' +
          '<td style="padding:8px 12px;"><span class="badge muted">无 PR</span></td></tr>';
      }).join('');
    }
    updateCount();
  }
  window.renderQuickPrTable = renderTable;

  function updateCount() {
    var n = selected.size;
    var cnt = $('quickPrSelectedCount'); if (cnt) cnt.textContent = '已选 ' + n + ' 个';
    var gc = $('quickPrGenCount'); if (gc) gc.textContent = n;
    var gb = $('quickPrGenerateDraft'); if (gb) gb.style.display = n > 0 ? 'inline-flex' : 'none';
  }

  function selectedRows() {
    return pendingRows().filter(function (r) { return selected.has(r.sourceDocCode); });
  }

  function showBatchPreview() {
    var rows = selectedRows();
    var card = $('quickPrPreviewCard'), content = $('quickPrPreviewContent');
    if (!card || !content) return;
    if (rows.length === 0) { alert('请先勾选至少一条申请单'); return; }
    content.innerHTML =
      '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:var(--r10);">' +
      '<table style="width:100%;border-collapse:collapse;font-size:12.5px;"><thead><tr style="background:var(--surface-2);">' +
      '<th style="padding:8px 12px;text-align:left;color:var(--text-3);">申请单号</th>' +
      '<th style="padding:8px 12px;text-align:left;color:var(--text-3);">软件</th>' +
      '<th style="padding:8px 12px;text-align:left;color:var(--text-3);">申请人</th>' +
      '<th style="padding:8px 12px;text-align:left;color:var(--text-3);">币种/单价</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr style="border-top:1px solid var(--border);">' +
          '<td style="padding:8px 12px;font-family:var(--mono);">' + esc(r.sourceDocCode) + '</td>' +
          '<td style="padding:8px 12px;font-weight:600;">' + esc(r.skuName) + (r.version ? ' ' + esc(r.version) : '') + '</td>' +
          '<td style="padding:8px 12px;">' + esc(r.claimUserName || r.requesterName) + '</td>' +
          '<td style="padding:8px 12px;">' + esc(r.currency || 'CNY') + ' ' + esc(r.unitPrice || '自动') + '</td></tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<div style="font-size:12px;color:var(--text-3);margin-top:8px;">共 ' + rows.length +
      ' 条，将逐条经 MCP ' + MCP_TOOL + ' 自动提需求单（订阅默认 1 个月）。</div>';
    card.style.display = 'block';
    $('quickPrSubmitStatus').textContent = '';
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function runBatch() {
    var rows = selectedRows();
    var statusEl = $('quickPrSubmitStatus');
    var btn = $('quickPrSubmitAll');
    if (rows.length === 0) { alert('没有可提交的条目'); return; }
    btn.disabled = true;
    var results = [];
    var chain = Promise.resolve();
    rows.forEach(function (r, i) {
      chain = chain.then(function () {
        statusEl.innerHTML = '⏳ 正在提单 ' + (i + 1) + '/' + rows.length + '：' +
          esc(r.skuName) + '（' + esc(r.sourceDocCode) + '）…';
        return autoDemand(r, { months: 1 })
          .then(function (x) { results.push({ req: r.sourceDocCode, sku: r.skuName, prCode: x.prCode, ok: true }); })
          .catch(function (err) { results.push({ req: r.sourceDocCode, sku: r.skuName, error: err.message, ok: false }); });
      });
    });
    chain.then(function () {
      var okList = results.filter(function (x) { return x.ok; });
      var failList = results.filter(function (x) { return !x.ok; });
      statusEl.innerHTML =
        '<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r10);padding:12px;">' +
        '<div style="font-weight:600;margin-bottom:6px;">批量完成：成功 ' + okList.length + ' · 失败 ' + failList.length + '</div>' +
        okList.map(function (x) { return '<div style="color:var(--green);">✅ ' + esc(x.sku) + '（' + esc(x.req) + '）→ ' + esc(x.prCode) + '</div>'; }).join('') +
        failList.map(function (x) { return '<div style="color:var(--red);">❌ ' + esc(x.sku) + '（' + esc(x.req) + '）：' + esc(x.error) + '</div>'; }).join('') +
        '</div>';
      okList.forEach(function (x) { selected.delete(x.req); });
      renderTable();
      btn.disabled = false;
    });
  }

  // ══════════════ 事件委托（一次性绑定，涵盖动态渲染的行）══════════════
  document.addEventListener('click', function (e) {
    // 弹窗按钮
    if (e.target.closest('#qprPreviewBtn')) {
      if (!qprCurrentRow) return;
      var row = qprCurrentRow, months = parseInt($('qprMonths').value, 10) || 1;
      $('qprPreviewArea').innerHTML =
        '<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r10);padding:12px;">' +
        '<div style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">需求单预览</div>' +
        '<div style="font-size:12.5px;color:var(--text-1);line-height:1.9;">' +
        '<strong>软件：</strong>' + esc(row.skuName) + (row.version ? ' ' + esc(row.version) : '') + '<br>' +
        '<strong>申请人：</strong>' + esc(row.claimUserName || row.requesterName) + ' · <strong>申请单：</strong>' + esc(row.sourceDocCode) + '<br>' +
        '<strong>币种/单价：</strong>' + esc(row.currency || 'CNY') + ' ' + esc(row.unitPrice || '自动查询') + '<br>' +
        '<strong>订阅期限：</strong>' + months + ' 个月<br>' +
        '<span style="color:var(--text-3);">确认后经 MCP ' + MCP_TOOL + ' 自动提需求单</span></div></div>';
      $('qprCreateBtn').style.display = 'inline-flex';
      if ($('qprSubmitBtn')) $('qprSubmitBtn').style.display = 'none';
      qprStatus('确认无误后点击「生成需求单」自动提单。', false);
      return;
    }
    if (e.target.closest('#qprCreateBtn')) { qprGenerate(); return; }
    if (e.target.closest('#qprSubmitBtn')) { qprGenerate(); return; } // 兜底：即使显示也只做 add_demand
    if (e.target.closest('#closeQuickPrModal')) { $('quickPrModal').classList.remove('open'); return; }

    // 行内「自动提需求单」按钮
    var quickBtn = e.target.closest('[data-quick-pr]');
    if (quickBtn) {
      var reqCode = quickBtn.getAttribute('data-quick-pr');
      var row = findRowByReq(reqCode) || {
        skuName: quickBtn.getAttribute('data-req-name') || '', version: '',
        currency: quickBtn.getAttribute('data-currency') || 'CNY',
        requesterName: quickBtn.getAttribute('data-applicant') || '',
        claimUserName: quickBtn.getAttribute('data-applicant') || '',
        sourceDocCode: reqCode, unitPrice: '',
        requesterDepartment: '', requesterDepartmentFull: '', claimUserDepartmentFull: ''
      };
      openModal(row);
      return;
    }

    // 列表页控件
    if (e.target.closest('#quickPrClearSelection')) {
      selected.clear();
      var all = $('quickPrSelectAll'); if (all) all.checked = false;
      renderTable();
      var pc = $('quickPrPreviewCard'); if (pc) pc.style.display = 'none';
      return;
    }
    if (e.target.closest('#quickPrGenerateDraft')) { showBatchPreview(); return; }
    if (e.target.closest('#quickPrBackToSelect')) {
      var pc2 = $('quickPrPreviewCard'); if (pc2) pc2.style.display = 'none';
      return;
    }
    if (e.target.closest('#quickPrSubmitAll')) { runBatch(); return; }

    // 切到「自动提需求单」标签时刷新列表
    if (e.target.closest('[data-tab="quick-pr"]')) { setTimeout(renderTable, 0); return; }
  });

  // 点遮罩关闭弹窗
  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'quickPrModal') e.target.classList.remove('open');
  });

  // 勾选
  document.addEventListener('change', function (e) {
    var chk = e.target.closest('[data-qpr-check]');
    if (chk) {
      var req = chk.getAttribute('data-qpr-check');
      if (chk.checked) selected.add(req); else selected.delete(req);
      updateCount();
      return;
    }
    if (e.target && e.target.id === 'quickPrSelectAll') {
      var on = e.target.checked;
      filteredRows().forEach(function (r) { if (on) selected.add(r.sourceDocCode); else selected.delete(r.sourceDocCode); });
      renderTable();
    }
  });

  // 搜索过滤
  document.addEventListener('input', function (e) {
    if (e.target && (e.target.id === 'quickPrSearchReq' || e.target.id === 'quickPrSearchSoftware')) renderTable();
  });

  // 初次渲染
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderTable);
  } else {
    renderTable();
  }
  console.log('✓ quick_pr_fixes.js 已加载：自动提需求单 → Neone PTP-MCP(add_demand)（手动提需求单不受影响）');
})();
