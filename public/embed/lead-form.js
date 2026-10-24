/* Lab of Future – embeddable enquiry form.
 *
 * <div id="lof-enquiry" data-branch="KRM" data-programme="ROB"></div>
 * <script src="https://crm.labofuture.example/embed/lead-form.js" data-crm="https://crm.labofuture.example" async></script>
 *
 * The website's origin must be listed in CRM → Settings → Configuration → Integrations → Website → Allowed origins.
 * Branch and programme lists come from data attributes (data-branches / data-programmes as "ID:Label,ID:Label") or default to a single hidden value.
 * For server-side forms, POST JSON to /webhooks/website with header X-LOF-Signature = hex HMAC-SHA256(body, WEBSITE_FORM_SECRET).
 */
(function () {
  var me = document.currentScript;
  var crm = (me && me.getAttribute('data-crm')) || '';
  var host = document.getElementById('lof-enquiry');
  if (!host || !crm) return;
  var opts = function (attr) {
    return String(host.getAttribute(attr) || '').split(',').filter(Boolean).map(function (x) { var p = x.split(':'); return { id: p[0].trim(), label: (p[1] || p[0]).trim() }; });
  };
  var branches = opts('data-branches'), progs = opts('data-programmes');
  var sel = function (name, list, fixed, label) {
    if (!list.length) return '<input type="hidden" name="' + name + '" value="' + (fixed || '') + '">';
    return '<label>' + label + '<select name="' + name + '" required>' + list.map(function (o) { return '<option value="' + o.id + '">' + o.label + '</option>'; }).join('') + '</select></label>';
  };
  host.innerHTML =
    '<form class="lof-f" novalidate>' +
    '<style>.lof-f{display:grid;gap:10px;font:14px Arial,sans-serif;max-width:460px}.lof-f label{display:grid;gap:4px}.lof-f input,.lof-f select,.lof-f textarea{padding:8px;border:1px solid #c9d1dc;border-radius:6px;font:inherit}.lof-f button{padding:10px;border:0;border-radius:6px;background:#2d5b9a;color:#fff;font-weight:600;cursor:pointer}.lof-f .c{display:flex;gap:8px;align-items:flex-start;font-size:12.5px}.lof-f .hp{position:absolute;left:-9999px}.lof-f .m{font-size:13px}</style>' +
    '<label>Student name<input name="student" required></label>' +
    '<label>Parent / guardian name<input name="parent" required></label>' +
    '<label>Mobile number<input name="phone" type="tel" required></label>' +
    '<label>E-mail<input name="email" type="email"></label>' +
    sel('branch', branches, host.getAttribute('data-branch'), 'Centre') +
    sel('prog', progs, host.getAttribute('data-programme'), 'Programme') +
    '<label>Message<textarea name="message" rows="3"></textarea></label>' +
    '<label class="c"><input type="checkbox" name="wa_consent" value="1"> I agree to be contacted on WhatsApp about this enquiry</label>' +
    '<label class="c"><input type="checkbox" name="email_consent" value="1"> I agree to receive e-mails about this enquiry</label>' +
    '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
    '<button type="submit">Send enquiry</button><div class="m" role="status"></div></form>';
  var f = host.querySelector('form'), msg = f.querySelector('.m');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var d = Object.fromEntries(new FormData(f).entries());
    if (!d.student || !d.parent || !d.phone) { msg.textContent = 'Please fill in the student name, parent name and mobile number.'; return; }
    var params = new URLSearchParams(location.search);
    d.utm = { source: params.get('utm_source'), medium: params.get('utm_medium'), campaign: params.get('utm_campaign') };
    d.campaign = params.get('utm_campaign') || 'Website Organic';
    d.page = location.href;
    f.querySelector('button').disabled = true;
    fetch(crm.replace(/\/+$/, '') + '/webhooks/website', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Error'); return j; }); })
      .then(function (j) { f.reset(); msg.textContent = 'Thank you! Your reference is ' + (j.reference || '') + '. Our counsellor will contact you shortly.'; })
      .catch(function () { msg.textContent = 'Sorry, we could not send your enquiry. Please call the centre.'; })
      .then(function () { f.querySelector('button').disabled = false; });
  });
})();
