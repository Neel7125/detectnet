// ================================================================
//  results.js — Standalone result tracking & rendering
//  Client side : call RES.clientFrame(sched, latMs, energyOrObj)
//                call RES.clientSend(ws, code, myId)
//  Host side   : call RES.hostReceive(clientId, data)
//                call RES.hostRender()
//  Note: DetectNet ships an inline copy in index.html (Vercel rewrite
//  constraint). Keep both in sync. Energy is E_total = compute + network.
// ================================================================

var RES = (function() {

  // ── CLIENT STATE ─────────────────────────────────────────────
  // schedData[sched] = { lats:[], energySum, computeSum, networkSum, frames }
  var schedData = {};
  var SCHEDS = ['greedy','pso','mompso','mompso-ga'];

  function _empty(){ return { lats: [], energySum: 0, computeSum: 0, networkSum: 0, frames: 0 }; }

  function clientReset() {
    schedData = {};
    SCHEDS.forEach(function(s) {
      schedData[s] = _empty();
    });
  }

  // energyOrObj = number (legacy total KJ) OR { totalKJ, computeKJ, networkKJ }
  function clientFrame(sched, latMs, energyOrObj) {
    if (!schedData[sched]) schedData[sched] = _empty();
    schedData[sched].lats.push(latMs);
    var total = 0, compute = 0, network = 0;
    if (energyOrObj && typeof energyOrObj === 'object') {
      total   = +energyOrObj.totalKJ   || 0;
      compute = +energyOrObj.computeKJ || 0;
      network = +energyOrObj.networkKJ || 0;
      if (!total && (compute || network)) total = compute + network;
    } else {
      total = +energyOrObj || 0;
      compute = total;
    }
    schedData[sched].energySum  += total;
    schedData[sched].computeSum += compute;
    schedData[sched].networkSum += network;
    schedData[sched].frames++;
  }

  // Build the payload and send via WebSocket
  function clientSend(ws, code, myId) {
    if (!ws || ws.readyState !== 1) return;
    var payload = {};
    var hasAny = false;
    SCHEDS.forEach(function(sched) {
      var d = schedData[sched];
      if (!d || d.frames === 0) return;
      var sumLat = 0;
      for (var i = 0; i < d.lats.length; i++) sumLat += d.lats[i];
      var avgLat = sumLat / d.lats.length;
      payload[sched] = {
        avgLat: avgLat,
        avgTime: avgLat / 1000,
        avgEnergy: d.energySum / d.frames,
        avgCompute: d.computeSum / d.frames,
        avgNetwork: d.networkSum / d.frames,
        frames: d.frames
      };
      hasAny = true;
    });
    if (!hasAny) return;
    var msg = JSON.stringify({ type: 'sched-result', code: code, clientId: myId, data: payload });
    try { ws.send(msg); } catch(e) { console.error('[RES] send error', e); }
  }

  // ── HOST STATE ───────────────────────────────────────────────
  // clientResults[clientId][sched] = { avgLat, avgTime, avgEnergy, avgCompute, avgNetwork, frames }
  var clientResults = {};

  function hostReset() {
    clientResults = {};
  }

  // Called when host receives a sched-result message
  function hostReceive(clientId, data) {
    if (!clientId || !data || typeof data !== 'object') return;
    clientResults[clientId] = data;
  }

  // Render the results table on the host
  function hostRender() {
    var sec    = document.getElementById('sResSec');
    var tbody  = document.getElementById('sResTbody');
    var subtitle = document.getElementById('sResSubtitle');
    if (!sec || !tbody) return;

    var ids = Object.keys(clientResults);
    if (ids.length === 0) return;

    var NAMES  = { greedy:'Greedy', pso:'PSO', mompso:'MOMPSO', 'mompso-ga':'MOMPSO-GA' };
    var COLORS = { greedy:'g',      pso:'b',   mompso:'p',       'mompso-ga':'a' };

    var html = '';
    var totTime = 0, totLat = 0, totEnergy = 0, totCompute = 0, totNetwork = 0, schedCount = 0;

    SCHEDS.forEach(function(sched) {
      var sumTime = 0, sumLat = 0, sumEnergy = 0, sumCompute = 0, sumNetwork = 0, found = false;
      ids.forEach(function(cid) {
        var d = clientResults[cid] && clientResults[cid][sched];
        if (d && d.frames > 0) {
          sumTime    += d.avgTime;
          sumLat     += d.avgLat;
          sumEnergy  += d.avgEnergy;
          sumCompute += (d.avgCompute != null ? d.avgCompute : d.avgEnergy);
          sumNetwork += (d.avgNetwork != null ? d.avgNetwork : 0);
          found = true;
        }
      });
      if (!found) return;
      totTime   += sumTime;
      totLat    += sumLat;
      totEnergy += sumEnergy;
      totCompute += sumCompute;
      totNetwork += sumNetwork;
      schedCount++;
      html += '<tr>'
        + '<td class="' + COLORS[sched] + '">' + NAMES[sched] + '</td>'
        + '<td class="bld">' + sumTime.toFixed(4) + 's</td>'
        + '<td>' + sumLat.toFixed(1) + 'ms</td>'
        + '<td title="compute ' + sumCompute.toFixed(6) + ' + network ' + sumNetwork.toFixed(6) + '">' + sumEnergy.toFixed(6) + 'KJ</td>'
        + '</tr>';
    });

    if (schedCount === 0) return;

    html += '<tr class="tot">'
      + '<td>TOTAL</td>'
      + '<td>' + totTime.toFixed(4) + 's</td>'
      + '<td>' + totLat.toFixed(1) + 'ms</td>'
      + '<td title="compute ' + totCompute.toFixed(6) + ' + network ' + totNetwork.toFixed(6) + '">' + totEnergy.toFixed(6) + 'KJ</td>'
      + '</tr>';

    tbody.innerHTML = html;
    if (subtitle) subtitle.textContent = ids.length + ' client(s) reported · E_total = compute + network';
    sec.style.display = 'block';
  }

  // ── PUBLIC API ───────────────────────────────────────────────
  return {
    clientReset:  clientReset,
    clientFrame:  clientFrame,
    clientSend:   clientSend,
    hostReset:    hostReset,
    hostReceive:  hostReceive,
    hostRender:   hostRender
  };

})();
