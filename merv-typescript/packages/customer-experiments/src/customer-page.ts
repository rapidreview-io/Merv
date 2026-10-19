import { createHash } from 'node:crypto';

// The customer surface deliberately does not load the signed-in project UI. Its
// request credential never becomes a project credential or leaves this origin.
const styles = String.raw`
:root{color-scheme:light;--bg:#f7f8fa;--surface:#fff;--soft:#f1f3f6;--ink:#111827;--muted:#4b5563;--line:#e5e7eb;--blue:#2563eb;--green:#1f7a3a;--amber:#946000;--red:#c0392b;font:14px/1.6 -apple-system,BlinkMacSystemFont,Inter,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}button,input{font:inherit}button,a,input{touch-action:manipulation}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #93b4fd;outline-offset:3px}a{color:var(--blue);text-underline-offset:3px}h1,h2,h3,p{margin:0}h1{font-size:clamp(28px,4vw,42px);line-height:1.18;letter-spacing:-1.2px;font-weight:600;max-width:760px}h2{font-size:17px;font-weight:600;line-height:1.4}h3{font-size:14px;font-weight:600}p{white-space:pre-wrap;overflow-wrap:anywhere}ul,ol{padding-left:20px;margin:12px 0 0}li+li{margin-top:7px}small,.muted{color:var(--muted)}small{font-size:12px}.shell{max-width:1120px;margin:auto;padding:0 36px}.header{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:20px}.brand{font-size:23px;font-weight:700;letter-spacing:-1.2px}.brand-dot{color:var(--blue)}.eyebrow{text-transform:uppercase;letter-spacing:1.6px;font-size:11px;font-weight:600;color:var(--muted)}.header-label{font-size:12px;color:var(--muted)}.hero{padding:48px 0 30px}.hero .eyebrow{margin-bottom:18px}.question{font-size:18px;line-height:1.6;margin-top:18px;max-width:770px;color:var(--muted)}.badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;white-space:nowrap}.badge::before{content:"";width:7px;height:7px;background:var(--blue);border-radius:50%;flex-shrink:0}.badge.good::before{background:var(--green)}.badge.warn::before{background:var(--amber)}.badge.bad::before{background:var(--red)}.progress{display:flex;padding:0;margin:0 0 38px;list-style:none;gap:0}.progress li{margin:0;flex:1;padding:12px 10px 0 0;border-top:2px solid var(--line);font-size:12px;color:var(--muted)}.progress li.active{border-color:var(--blue);color:var(--blue);font-weight:600}.progress li.done{border-color:var(--green)}.layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:64px;align-items:start}.section{padding:25px 0;border-top:1px solid var(--line)}.section:first-child{border-top:none;padding-top:0}.section>p{margin-top:12px}.section-label{display:flex;align-items:baseline;justify-content:space-between;gap:15px;margin-bottom:14px}.method{display:flex;flex-direction:column;gap:12px;margin:20px 0 0;align-items:stretch}.method-step{flex:1;min-width:0;border:1px solid var(--line);background:var(--surface);border-radius:6px;padding:15px}.step-no{font-size:10px;letter-spacing:1px;color:var(--muted);margin-bottom:6px}.method-step p{font-size:13px;margin-top:6px;color:var(--muted)}.method-arrow{transform:rotate(90deg);align-self:center;color:var(--muted);font-size:18px}.dataset{padding:17px 0;border-top:1px solid var(--line)}.dataset:first-child{border-top:none;padding-top:0}.data-heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px}.role{text-transform:uppercase;font-size:10px;letter-spacing:1px;font-weight:600;color:var(--blue)}.dataset p{font-size:13px;margin-top:5px}.dataset ul{font-size:12px;color:var(--muted);margin-top:9px}.file{display:flex;align-items:baseline;gap:10px;justify-content:space-between;margin-top:9px;font-size:12px;padding:8px 10px;background:var(--soft);border-radius:4px}.file-name{overflow-wrap:anywhere;min-width:0}.file .badge{font-size:11px}.upload{margin-top:12px}.upload input{font-size:12px;max-width:100%;color:var(--muted)}input::file-selector-button,.secondary{padding:7px 12px;border:1px solid var(--line);background:var(--surface);border-radius:5px;color:var(--ink);font-weight:500}.upload-note{display:block;margin-top:6px;overflow-wrap:anywhere}.aside{position:sticky;top:28px;max-height:calc(100dvh - 56px);overflow:auto;border-top:2px solid var(--ink);padding-top:20px}.price{font-size:32px;letter-spacing:-1px;font-weight:600;line-height:1.2}.price small{font-size:12px;font-weight:400;letter-spacing:0}.aside h2{margin-bottom:9px}.aside>p{font-size:13px;color:var(--muted);margin:12px 0}.aside dl{margin:22px 0}.aside dl>div{display:flex;justify-content:space-between;gap:15px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px}.aside dt{color:var(--muted)}.aside dd{margin:0;text-align:right;overflow-wrap:anywhere}.checkout{border-top:1px solid var(--line);padding-top:18px}.checkout label{display:block;font-size:12px;font-weight:500}.checkout input[type=email]{width:100%;background:var(--surface);border:1px solid #cdd2db;border-radius:5px;padding:10px 12px;margin:7px 0 12px;color:var(--ink)}.consent{display:flex!important;gap:9px;align-items:flex-start;font-weight:400!important;color:var(--muted);line-height:1.5}.consent input{margin:3px 0 0;flex-shrink:0}.primary{width:100%;margin-top:18px;padding:12px 16px;background:var(--blue);color:white;border:0;border-radius:5px;font-weight:600}.primary:hover:not(:disabled){background:#1d4ed8}.checkout-note{font-size:11px!important;margin:10px 0 0!important;text-align:center}.status-copy{font-size:13px;color:var(--muted);margin-top:8px}.notice{border-left:3px solid var(--blue);background:#eef4ff;padding:12px 15px;font-size:13px;margin:0 0 26px;white-space:pre-wrap;overflow-wrap:anywhere}.notice.error{border-color:var(--red);background:#fff2f0;color:#84271e}.notice[hidden]{display:none}.empty{padding:65px 0 90px;max-width:600px}.empty h1{font-size:30px;margin-bottom:15px}.empty p{color:var(--muted)}.empty button{margin-top:22px}.research{list-style:none;padding:0}.research li{padding:9px 0;border-bottom:1px solid var(--line)}.research p{font-size:12px;color:var(--muted);margin-top:3px}.conversation{margin-top:18px}.message{margin:13px 0;padding-left:15px;border-left:2px solid var(--line)}.message p{font-size:13px;margin-top:4px}.message .eyebrow{font-size:10px}.result{border-left:3px solid var(--green);padding:2px 0 2px 16px;margin-top:16px}.result p{margin-top:8px}.artifact{display:block;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px}details{padding-top:16px}summary{font-size:12px;cursor:pointer;color:var(--muted)}pre{font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:var(--soft);border-radius:4px;max-height:400px;overflow:auto}.footer{border-top:1px solid var(--line);margin-top:54px;padding:24px 0 36px;display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:11px}.live{font-size:11px;color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.aside p.price{font-size:32px;line-height:1.2;color:var(--ink)}.method+h3{margin-top:16px}button.artifact{width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);color:var(--blue)}
@media(max-width:860px){.layout{gap:35px;grid-template-columns:minmax(0,1fr) 265px}.shell{padding:0 24px}.method{flex-direction:column;gap:7px}.method-arrow{transform:rotate(90deg);line-height:1}.hero{padding-top:35px}}
@media(max-width:640px){.shell{padding:0 21px}.header{height:68px}.header-label{font-size:10px}.hero{padding:30px 0 25px}.question{font-size:16px}.layout{display:flex;flex-direction:column;gap:32px}.main,.aside{width:100%}.aside{position:static;max-height:none;overflow:visible;order:-1;padding:18px;background:none}.aside dl{margin:13px 0}.aside .details-summary{display:none}.price{font-size:27px}.progress{margin-bottom:26px}.progress li{font-size:10px;padding-right:5px}.section{padding:23px 0}.footer{margin-top:35px;flex-direction:column;gap:7px}.data-heading{align-items:flex-start}.method{flex-direction:column}.hero .eyebrow{margin-bottom:12px}}
@media(prefers-reduced-motion:no-preference){button{transition:background .12s ease}}
`;

const client = String.raw`
'use strict';
(() => {
  const requestId = CONFIG.requestId;
  const apiBase = '/customer-experiments/requests/' + encodeURIComponent(requestId);
  const storageKey = 'merv:customer-experiment:' + requestId;
  const fragment = location.hash.slice(1);
  let token = '';
  try {
    token = fragment.startsWith('token=') ? new URLSearchParams(fragment).get('token') || '' : decodeURIComponent(fragment);
    if (token) sessionStorage.setItem(storageKey, token);
    else token = sessionStorage.getItem(storageKey) || '';
  } catch (_) { /* A private browser may disallow storage; the current visit still works. */ }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const app = document.getElementById('app');
  const notice = document.getElementById('notice');
  const live = document.getElementById('live');
  let snapshot = null;
  let busy = false;
  let email = '';
  let consentVersion = null;
  let timer = null;
  let stopped = false;
  const uploadMessages = new Map();
  const labels = {intake:'Planning',planning:'Planning',ready:'Ready for approval',awaiting_payment:'Awaiting payment',queued:'Queued',running:'Running',finalizing:'Preparing results',results_review:'Checking results',complete:'Complete',failed:'Needs attention',cancelled:'Cancelled'};
  const copy = {intake:'Merv is working with your agent to turn your question into an executable plan.',planning:'Merv is working with your agent to turn your question into an executable plan.',ready:'Your plan is ready. Approving it fixes this version and takes you to secure checkout.',awaiting_payment:'This plan has been approved. Execution begins after payment is confirmed.',queued:'Payment is confirmed. Your approved experiment is waiting for its execution agent.',running:'Merv is running the approved experiment within its agreed limits.',finalizing:'The run has finished. Merv is collecting the code, outputs, and evidence.',results_review:'A separate agent is checking the results against your approved plan.',complete:'Your experiment is complete. The findings and evidence are ready below.',failed:'This experiment needs attention. Its status and any available findings are shown below.',cancelled:'This experiment has been cancelled.'};
  const list = value => Array.isArray(value) ? value : [];
  const string = value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = string(text);
    if (className) node.className = className;
    return node;
  }
  function append(parent, ...nodes) { for (const node of nodes) if (node) parent.append(node); return parent; }
  function badge(text, kind) { return el('span', text, 'badge ' + (kind || '')); }
  function section(title) { const node = el('section', null, 'section'); node.append(el('h2', title)); return node; }
  function showNotice(message, isError) { notice.textContent = message || ''; notice.className = 'notice' + (isError ? ' error' : ''); notice.hidden = !message; }
  function safeLink(href, label, className) {
    try {
      const url = new URL(href, location.origin);
      if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && url.origin !== location.origin)) return el('span', label, className);
      const node = el('a', label, className);
      node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; node.referrerPolicy = 'no-referrer';
      return node;
    } catch (_) { return el('span', label, className); }
  }
  function resultLink(item, file) {
    const label = file ? (item.title || item.name || 'Result') + ' / ' + file.name : item.title || item.name || 'Open result';
    let id = item.id;
    if (!id && item.url) {
      try { const url = new URL(item.url,location.origin); const prefix = apiBase + '/artifacts/'; if(url.origin === location.origin && url.pathname.startsWith(prefix)) id = decodeURIComponent(url.pathname.slice(prefix.length)); } catch(_) {}
    }
    if(!id) return item.url ? safeLink(item.url,label,'artifact') : el('p',label,'artifact');
    const button = el('button',label,'artifact'); button.type='button';
    button.addEventListener('click',async() => {
      if(button.disabled) return;
      const tab = window.open('about:blank','_blank'); if(tab) tab.opener=null;
      button.disabled=true; showNotice('',false);
      try {
        const response = await api('/artifacts/' + encodeURIComponent(id) + (file ? '?fileName=' + encodeURIComponent(file.name) : ''));
        const url = new URL(response.download.url,location.origin);
        if(url.protocol !== 'https:' && url.origin !== location.origin) throw new Error('Merv returned an invalid download destination.');
        if(tab) tab.location.replace(url.href); else location.assign(url.href);
      } catch(error) { if(tab) tab.close(); showNotice(error.message || 'This result could not be downloaded. Please try again.',true); }
      finally { button.disabled=false; }
    });
    return button;
  }
  function bulletList(items) {
    const node = el('ul');
    for (const item of list(items)) node.append(el('li', typeof item === 'string' ? item : item.description || item.name || JSON.stringify(item)));
    return node;
  }
  function money(amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return 'Price pending';
    try { return new Intl.NumberFormat(undefined, {style:'currency',currency:currency || 'USD',maximumFractionDigits:amount % 100 ? 2 : 0}).format(amount / 100); }
    catch (_) { return (amount / 100).toFixed(2) + ' ' + (currency || 'USD'); }
  }
  async function api(path, body) {
    const response = await fetch(apiBase + path, {method:body === undefined ? 'GET':'POST',headers:{Authorization:'Bearer ' + token,...(body === undefined ? {} : {'Content-Type':'application/json'})},body:body === undefined ? undefined : JSON.stringify(body),credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    let data;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!response.ok) {
      const raw = data && (data.message || (data.error && (data.error.message || data.error)));
      const error = new Error(typeof raw === 'string' ? raw : response.status === 401 || response.status === 403 ? 'This private link is invalid or has expired. Ask your agent for a new link.' : 'Merv could not complete that request. Please try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function currentVersion(data) { return data.contractVersion ?? (data.contract && data.contract.version) ?? null; }
  function unpack(data) { return data && (data.request || data.snapshot) || data; }
  function stateOf(data) { return data.state || data.workflow && data.workflow.state || data.status || 'planning'; }
  function planOf(data) { return data.plan || data.contract && (data.contract.plan || data.contract) || data.draft || {}; }
  function requirementsOf(data, plan) { return list(data.requirements || data.dataRequirements || plan.dataRequirements || plan.datasets); }
  function contractPrice(data, plan) { return data.price || data.contract && data.contract.price || plan.price || {}; }
  function rows(parent, values) { const dl = el('dl'); for (const [name,value] of values) if (value) append(dl, append(el('div'),el('dt',name),el('dd',value))); parent.append(dl); }
  function render(data) {
    const previousEmail = document.getElementById('email');
    if (previousEmail) email = previousEmail.value;
    const state = stateOf(data);
    const plan = planOf(data);
    const version = currentVersion(data);
    if (consentVersion !== null && consentVersion !== version) consentVersion = null;
    document.title = (plan.title || data.title || 'Your experiment') + ' · Merv';
    const fragment = document.createDocumentFragment();
    const hero = el('div', null, 'hero');
    append(hero,el('p','Merv / Experiments','eyebrow'),el('h1',plan.title || data.title || 'Let’s make this testable.'));
    if (plan.question || plan.decision) hero.append(el('p',plan.question || plan.decision,'question'));
    fragment.append(hero);
    const progress = el('ol', null, 'progress'); progress.setAttribute('aria-label','Experiment progress');
    const phases = ['Plan','Approve & pay','Run','Results'];
    const phase = ['intake','planning'].includes(state) ? 0 : ['ready','awaiting_payment'].includes(state) ? 1 : ['queued','running','finalizing','results_review'].includes(state) ? 2 : state === 'complete' ? 3 : 0;
    phases.forEach((name,index) => { const step = el('li',name,index < phase ? 'done' : index === phase ? 'active' : ''); if(index === phase) step.setAttribute('aria-current','step'); progress.append(step); });
    fragment.append(progress);
    const layout = el('div', null, 'layout');
    const main = el('main', null, 'main');
    const rationale = plan.rationale || plan.why || plan.motivation;
    if (rationale) append(main,append(section('Why run this experiment'),el('p',rationale)));
    if (plan.hypothesis) append(main,append(section('The hypothesis'),el('p',plan.hypothesis)));
    const method = plan.method || plan.comparison;
    if (method) {
      const area = section('What we’ll test');
      if (typeof method === 'string') area.append(el('p',method));
      else {
        const steps = Array.isArray(method) ? method : list(method.steps);
        if (method.description) area.append(el('p',method.description));
        const diagram = el('div', null, 'method'); diagram.setAttribute('aria-label','Experiment method');
        steps.forEach((step,index) => { if(index) diagram.append(el('span','→','method-arrow')); const box = el('div',null,'method-step'); append(box,el('div',String(index + 1).padStart(2,'0'),'step-no'),el('h3',typeof step === 'string' ? step : step.title || step.name || 'Step ' + (index + 1))); if(typeof step !== 'string' && step.description) box.append(el('p',step.description)); diagram.append(box); });
        if (steps.length) area.append(diagram);
      }
      if (plan.baseline) append(area,el('h3','Baseline'),el('p',typeof plan.baseline === 'string' ? plan.baseline : JSON.stringify(plan.baseline)));
      main.append(area);
    }
    const requirements = requirementsOf(data,plan);
    const uploads = list(data.uploads || data.files || data.manifest && data.manifest.files || data.contract && data.contract.datasets);
    if (requirements.length) {
      const area = section('Data for this experiment');
      area.append(el('p','Files are checked against the requirements below before the plan can be approved. Approved dataset versions stay fixed.','muted'));
      for (const requirement of requirements) {
        const id = requirement.id || requirement.requirementId;
        const part = el('div',null,'dataset');
        const files = uploads.filter(file => file.requirementId === id || file.datasetId === id);
        const heading = el('div',null,'data-heading');
        const validated = files.length && files.every(file => file.validatedAt || ['valid','validated','ready'].includes(file.validationStatus || file.status));
        append(heading,append(el('div'),el('span',requirement.role || 'Data','role'),el('h3',requirement.label || requirement.name || requirement.title || id)),badge(requirement.status || (validated ? 'Validated' : files.length ? 'Files received' : requirement.required === false ? 'Optional' : 'Required'),validated || requirement.status === 'validated' || requirement.status === 'ready' ? 'good' : 'warn'));
        append(part,heading);
        if(requirement.description) part.append(el('p',requirement.description));
        const notes = [];
        const formats = requirement.format ? [requirement.format] : list(requirement.formats || requirement.fileTypes);
        if (formats.length) notes.push('File types: ' + formats.join(', '));
        const columns = list(requirement.columns || requirement.requiredColumns);
        if (columns.length) notes.push('Required columns: ' + columns.map(column => typeof column === 'string' ? column : column.name).join(', '));
        if (requirement.labelColumn) notes.push('Label column: ' + requirement.labelColumn);
        const allowedLabels = list(requirement.labels || requirement.allowedLabels);
        if (allowedLabels.length) notes.push('Labels: ' + allowedLabels.join(', '));
        notes.push('Maximum file size: ' + formatBytes(requirement.maxBytes || data.maxUploadBytes || 20 * 1024 * 1024));
        if(requirement.minRows) notes.push('At least ' + requirement.minRows + ' rows');
        if(notes.length) part.append(bulletList(notes));
        files.forEach(file => { const status = file.validationStatus || file.status || (file.validatedAt ? 'validated' : 'Received'); const row = el('div',null,'file'); append(row,el('span',file.filename || file.name || file.path || 'Uploaded file','file-name'),badge(status,['validated','valid','ready'].includes(status) ? 'good' : ['invalid','failed','rejected'].includes(status) ? 'bad' : 'warn')); part.append(row); if(file.validationError || file.error) part.append(el('small',file.validationError || file.error,'upload-note')); });
        if (['intake','planning','ready'].includes(state) && id) {
          const field = el('div',null,'upload'); const input = el('input'); input.type = 'file'; input.disabled = busy || data.uploadAvailable === false; input.setAttribute('aria-label','Upload ' + (requirement.label || requirement.name || requirement.title || requirement.role || 'data')); input.dataset.requirementId = id;
          input.accept = formats.map(format => /^(text|application)\//.test(format) ? format : '.' + format.replace(/^\./,'')).join(',');
          input.addEventListener('change',() => { if(input.files && input.files[0]) void uploadFile(input.files[0],requirement); });
          append(field,input,el('small',uploadMessages.get(id) || (data.uploadAvailable === false ? 'Uploads are temporarily unavailable. Your plan is saved.' : 'Your files stay private to this experiment.'),'upload-note')); part.append(field);
        }
        area.append(part);
      }
      main.append(area);
    } else if (['ready','awaiting_payment','queued','running','finalizing','results_review','complete'].includes(state)) {
      append(main,append(section('Data readiness'),el('p','No customer uploads are required for this plan.','muted')));
    }
    const success = plan.successCriteria || plan.success;
    if (success) { const area = section('What will count as a useful result'); area.append(typeof success === 'string' ? el('p',success) : bulletList(success)); if(plan.metric) area.append(el('p','Metric: ' + (typeof plan.metric === 'string' ? plan.metric : JSON.stringify(plan.metric)))); main.append(area); }
    const deliverables = list(plan.deliverables);
    if(deliverables.length) main.append(append(section('What you’ll receive'),bulletList(deliverables)));
    const research = list(plan.research || plan.inspiration || plan.references);
    if(research.length) { const area = section('Research & prior work'); const items = el('ul',null,'research'); research.forEach(item => { const row = el('li'); if(typeof item === 'string') row.append(el('span',item)); else { row.append(item.url ? safeLink(item.url,item.title || item.url) : el('span',item.title || item.citation)); if(item.relevance || item.description) row.append(el('p',item.relevance || item.description)); } items.append(row); }); main.append(append(area,items)); }
    const result = data.result || data.results || data.submission;
    if(result) { const area = section(state === 'complete' ? 'Your results' : 'Results so far'); if(typeof result === 'string') area.append(el('p',result)); else { if(result.summary || result.conclusion) area.append(append(el('div',null,'result'),el('h3',result.title || 'Findings'),el('p',result.summary || result.conclusion))); list(result.artifacts || result.deliverables || result.links).forEach(item => { if(list(item.files).length) list(item.files).forEach(file => area.append(resultLink(item,typeof file === 'string' ? {name:file} : file))); else area.append(resultLink(item)); }); } main.append(area); }
    const conversation = list(data.conversation || data.messages || data.transcript);
    if (conversation.length) { const area = section('The planning conversation'); const details = el('details'); if(['intake','planning'].includes(state)) details.open = true; details.append(el('summary','View conversation with your agent')); const thread = el('div',null,'conversation'); conversation.forEach(message => append(thread,append(el('div',null,'message'),el('span',message.role === 'assistant' || message.role === 'merv' ? 'Merv' : 'Your agent','eyebrow'),el('p',message.text || message.content || message.message)))); append(area,append(details,thread)); main.append(area); }
    const questions = list(data.questions || data.openQuestions || plan.openQuestions);
    if(questions.length) main.append(append(section('Still to resolve'),bulletList(questions)));
    if(!main.children.length) append(main,append(section('Planning is in progress'),el('p','Your agent and Merv will fill in the question, method, data requirements, and success criteria here. The plan can be submitted once it fits the supported limits.','muted')));
    const technical = el('details'); technical.append(el('summary','Plan details')); technical.append(el('pre',JSON.stringify({version,plan,manifest:data.manifest || data.contract && (data.contract.manifest || data.contract.datasets)},null,2))); main.append(technical);
    const aside = el('aside',null,'aside');
    aside.append(badge(labels[state] || state,state === 'complete' ? 'good' : ['failed','cancelled'].includes(state) ? 'bad' : ''));
    const price = contractPrice(data,plan);
    if(['ready','awaiting_payment'].includes(state)) { const line = el('p',money(price.amountCents ?? price.amount ?? data.priceCents,price.currency),'price'); line.append(el('small',' / experiment')); aside.append(line); }
    aside.append(el('p',data.statusMessage || copy[state] || 'Merv is updating this experiment.','status-copy'));
    const limits = plan.limits || data.limits || {};
    rows(aside,[['Plan version',version === null ? 'Draft' : String(version)],['Expected turnaround',plan.turnaround || plan.expectedTurnaround || limits.turnaround],['Agent working time limit',limits.wallMinutes ? limits.wallMinutes + ' minutes' : limits.maxWallTimeMinutes ? limits.maxWallTimeMinutes + ' minutes' : limits.maxDurationMinutes ? limits.maxDurationMinutes + ' minutes' : limits.time],['Compute','Selected by Merv'],['Attempts',limits.maxAttempts ? String(limits.maxAttempts) : ''],['Deliverables',deliverables.length ? String(deliverables.length) : '']]);
    if(['ready','awaiting_payment'].includes(state)) {
      const form = el('form',null,'checkout');
      const emailLabel = el('label','Email for your results'); emailLabel.htmlFor = 'email';
      const input = el('input'); input.type='email'; input.name='email'; input.id='email'; input.required=true; input.autocomplete='email'; input.placeholder='you@example.com'; input.value=email || data.email || data.acceptance && data.acceptance.email || ''; input.disabled=busy;
      input.addEventListener('input',() => { email=input.value; }); append(form,emailLabel,input);
      const approved = state === 'awaiting_payment';
      input.readOnly=approved;
      let checkbox;
      if(!approved) { const label=el('label',null,'consent'); checkbox=el('input'); checkbox.type='checkbox'; checkbox.required=true; checkbox.checked=consentVersion === version; checkbox.disabled=busy; checkbox.addEventListener('change',() => { consentVersion=checkbox.checked ? version:null; }); append(label,checkbox,el('span','I approve this plan and its fixed dataset version. Changes to the agreed scope will need my approval.')); form.append(label); }
      const button=el('button',busy ? 'Working…' : approved ? 'Continue to payment' : 'Approve & continue','primary'); button.type='submit'; button.disabled=busy || version === null || data.canCheckout === false || data.checkoutAvailable === false; form.append(button);
      form.append(el('p',data.checkoutAvailable === false ? 'Checkout is temporarily unavailable. Your plan is saved.' : 'Execution starts only after payment is confirmed.','muted checkout-note'));
      form.addEventListener('submit',event => { event.preventDefault(); if(!form.reportValidity() || busy || version === null || data.canCheckout === false || data.checkoutAvailable === false) return; email=input.value.trim(); if(!approved && !checkbox.checked) return; void checkout(version,email,approved); });
      aside.append(form);
    } else if (state === 'complete' && data.emailDelivery) {
      aside.append(el('p',data.emailDelivery.status === 'sent' ? 'A results email has been sent.' : data.emailDelivery.status === 'failed' ? 'The results email could not be sent. Your results remain available here.' : 'Your results email is being prepared.','status-copy'));
    }
    if(data.blockers && list(data.blockers).length) aside.append(bulletList(data.blockers));
    append(layout,main,aside); fragment.append(layout); app.replaceChildren(fragment);
    live.textContent='Updated ' + new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  }
  function formatBytes(bytes) { return bytes >= 1024 * 1024 ? Math.ceil(bytes / (1024 * 1024)) + ' MB' : Math.ceil(bytes / 1024) + ' KB'; }
  async function uploadFile(file,requirement) {
    if(busy) return;
    const maxBytes = requirement.maxBytes || snapshot.maxUploadBytes || 20 * 1024 * 1024;
    if(maxBytes && file.size > maxBytes) { showNotice('This file exceeds the ' + formatBytes(maxBytes) + ' limit for ' + (requirement.label || requirement.name || requirement.role) + '.',true); return; }
    busy=true; const id=requirement.id || requirement.requirementId; uploadMessages.set(id,'Checking file and preparing upload…'); showNotice('',false); render(snapshot);
    try {
      const bytes=await file.arrayBuffer();
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      const sha256=Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,'0')).join('');
      const mediaType=file.type || (file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/octet-stream');
      const upload=await api('/uploads',{requirementId:id,filename:file.name,size:file.size,sha256,mediaType});
      const destination=new URL(upload.url,location.origin);
      if(destination.protocol !== 'https:' && destination.origin !== location.origin) throw new Error('Merv returned an invalid upload destination.');
      uploadMessages.set(id,'Uploading ' + file.name + '…'); render(snapshot);
      const response=await fetch(destination.href,{method:'PUT',headers:upload.headers || {'Content-Type':mediaType},body:file,credentials:'omit',referrerPolicy:'no-referrer'});
      // A retry may find the same immutable object after an earlier PUT succeeded.
      // Completion still verifies its size, hash, and contents on the server.
      if(!response.ok && response.status !== 412) throw new Error('The upload did not finish. Please choose the file to try again.');
      uploadMessages.set(id,'Upload received. Checking file contents…'); render(snapshot);
      await api('/uploads/' + encodeURIComponent(upload.uploadId) + '/complete',{});
      uploadMessages.delete(id);
      snapshot=unpack(await api(''));
      showNotice('Your file was received. Validation status is shown beside the file.',false);
    } catch(error) { uploadMessages.set(id,'Upload needs attention.'); showNotice(error.message || 'The upload failed. Please try again.',true); }
    finally { busy=false; if(snapshot) render(snapshot); }
  }
  async function checkout(version,address,approved) {
    busy=true; showNotice('',false); render(snapshot);
    try {
      if(!approved) await api('/accept',{contractVersion:version,email:address});
      const response=await api('/checkout',{contractVersion:version,email:address});
      const url=new URL(response.url || response.checkoutUrl);
      if(url.protocol !== 'https:') throw new Error('Merv returned an invalid payment link. Please try again.');
      location.assign(url.href);
    } catch(error) { showNotice(error.message || 'Checkout is unavailable. Please try again.',true); try { snapshot=unpack(await api('')); } catch(_) {} }
    finally { busy=false; if(snapshot) render(snapshot); }
  }
  async function refresh() {
    if(stopped || busy || document.hidden || (app.contains(document.activeElement) && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))) return;
    try { snapshot=unpack(await api('')); render(snapshot); if(notice.dataset.connectionError) { showNotice('',false); delete notice.dataset.connectionError; } }
    catch(error) {
      if(error.status === 401 || error.status === 403) { stopped=true; try { sessionStorage.removeItem(storageKey); } catch(_) {} }
      showNotice(error.message,true); notice.dataset.connectionError='true';
      if(!snapshot) { const empty=el('div',null,'empty'); append(empty,el('h1','We couldn’t load your experiment.'),el('p','Your plan will appear here when this private link can connect to Merv.')); if(!stopped) { const retry=el('button','Try again','secondary'); retry.addEventListener('click',() => void refresh()); empty.append(retry); } app.replaceChildren(empty); }
    }
  }
  if(!token) {
    const empty=el('div',null,'empty'); append(empty,el('h1','Open your private experiment link.'),el('p','Ask your agent for the experiment page link from Merv. That link gives you access to your plan, uploads, and results.')); app.replaceChildren(empty);
  } else {
    void refresh(); timer=setInterval(() => void refresh(),10000);
    document.addEventListener('visibilitychange',() => { if(!document.hidden) void refresh(); });
    window.addEventListener('pagehide',() => { clearInterval(timer); timer=null; });
    window.addEventListener('pageshow',event => { if(event.persisted && !stopped) { if(!timer) timer=setInterval(() => void refresh(),10000); void refresh(); } });
  }
})();
`;

function scriptJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** A self-contained customer page. The caller must also send no-store headers. */
export function customerPage(requestId: string): string {
  const script = 'const CONFIG = ' + scriptJSON({ requestId }) + ';\n' + client;
  const hash = (text: string) =>
    "'sha256-" + createHash('sha256').update(text).digest('base64') + "'";
  const policy = `default-src 'none'; script-src ${hash(script)}; style-src ${hash(styles)}; connect-src 'self' https:; base-uri 'none'; form-action 'self' https://checkout.stripe.com`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>Your experiment · Merv</title><style>${styles}</style></head><body><div class="shell"><header class="header"><div class="brand" aria-label="Merv">merv<span class="brand-dot">.</span></div><span class="header-label">A question. A clear test. Evidence.</span></header><div id="notice" class="notice" role="status" aria-live="polite" hidden></div><div id="app"><div class="empty"><h1>Opening your experiment…</h1><p>Your private plan, data, and results will appear here.</p></div></div><noscript><p>This experiment page needs JavaScript to securely load your plan.</p></noscript><footer class="footer"><span>Private to your experiment.</span><span id="live" class="live" aria-live="off"></span></footer></div><script>${script}</script></body></html>`;
}
