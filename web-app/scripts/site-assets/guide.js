// The guide page's behaviour: paging, search, copy buttons, language switch.
//
// The markup is complete without this file — every page is in the document, in
// order. This script only narrows it to one page at a time, which is why the
// first thing it does is add `js` to <html>: the one-page-at-a-time CSS is
// keyed on that class, so with scripting off nothing is hidden.
//
// Links between pages keep the in-app form `#guide/<id>`, so the same markdown
// works in both places and a link to a page can be shared as a URL.
(function () {
  'use strict';
  var S = window.GUIDE || {};
  var root = document.documentElement;
  var pages = Array.prototype.slice.call(document.querySelectorAll('.gpage'));
  var links = Array.prototype.slice.call(document.querySelectorAll('.idx'));
  var index = document.getElementById('gindex');
  var hitsBox = document.getElementById('ghits');
  var search = document.getElementById('gsearch');
  var other = document.getElementById('lang-other');
  var otherBase = other ? other.getAttribute('href') : '';
  if (!pages.length) return;
  root.classList.add('js');

  function idFromHash() {
    var m = /^#guide\/([A-Za-z]+)$/.exec(location.hash);
    var id = m ? m[1] : S.home;
    for (var i = 0; i < pages.length; i++) if (pages[i].dataset.page === id) return id;
    return S.home;
  }

  function show(id, keepScroll) {
    pages.forEach(function (p) { p.classList.toggle('current', p.dataset.page === id); });
    links.forEach(function (a) {
      var on = a.dataset.page === id;
      a.classList.toggle('current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    root.classList.remove('show-index');
    // The other language opens on the same page, not on its home.
    if (other) other.setAttribute('href', otherBase + '#guide/' + id);
    // A new page starts at its own top; otherwise a link followed from the
    // bottom of a long page lands mid-way down the next one.
    if (!keepScroll) window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', function () { show(idFromHash()); });
  show(idFromHash(), true);

  var toggle = document.getElementById('gtoggle');
  if (toggle) toggle.addEventListener('click', function () {
    root.classList.add('show-index');
    window.scrollTo(0, 0);
  });
  // Picking the page that is already open changes no hash, so close the index by hand.
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a.idx, a.hit') : null;
    if (a && a.getAttribute('href') === location.hash) show(idFromHash());
  });

  // ── search: every page's text, case-insensitive, counted per page ──────
  // textContent alone glues a table cell to the next one ("OBS StudioColours"),
  // so a space is put at every block end before the tags are dropped.
  var texts = pages.map(function (p) {
    var box = document.createElement('div');
    box.innerHTML = p.innerHTML.replace(/<\/(td|th|tr|li|p|h[1-6]|pre)>/g, ' $&');
    return { id: p.dataset.page, title: p.dataset.title, text: box.textContent.replace(/\s+/g, ' ') };
  });

  function runSearch() {
    var q = search.value.trim();
    if (!q) { hitsBox.hidden = true; index.hidden = false; hitsBox.textContent = ''; return; }
    var needle = q.toLowerCase();
    var found = [];
    texts.forEach(function (t) {
      var hay = t.text.toLowerCase();
      var count = 0, first = -1, at = hay.indexOf(needle);
      while (at !== -1) { if (first < 0) first = at; count++; at = hay.indexOf(needle, at + needle.length); }
      if (count) found.push({ t: t, count: count, first: first });
    });
    found.sort(function (a, b) { return b.count - a.count; });
    hitsBox.textContent = '';
    if (!found.length) {
      var none = document.createElement('p');
      none.className = 'hit-none';
      none.textContent = String(S.none || '').replace('{q}', q);
      hitsBox.appendChild(none);
    }
    found.forEach(function (f) {
      var a = document.createElement('a');
      a.className = 'hit';
      a.href = '#guide/' + f.t.id;
      var head = document.createElement('span'); head.className = 'hit-head';
      var title = document.createElement('span'); title.textContent = f.t.title;
      var count = document.createElement('span'); count.className = 'hit-count';
      count.textContent = String(S.hits || '').replace('{n}', f.count);
      head.appendChild(title); head.appendChild(count);
      var snip = document.createElement('span'); snip.className = 'hit-snip';
      var from = Math.max(0, f.first - 30);
      snip.textContent = (from > 0 ? '…' : '') + f.t.text.slice(from, f.first + needle.length + 60).trim() + '…';
      a.appendChild(head); a.appendChild(snip);
      hitsBox.appendChild(a);
    });
    index.hidden = true; hitsBox.hidden = false;
  }
  if (search) search.addEventListener('input', runSearch);

  // ── copy buttons on code blocks ────────────────────────────────────────
  // "Copied" is shown only when the copy actually succeeded.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return Promise.resolve(ok);
    } catch (e) { return Promise.resolve(false); }
  }
  Array.prototype.forEach.call(document.querySelectorAll('.prose pre'), function (pre) {
    var text = pre.textContent;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'copybtn'; b.textContent = S.copy || 'Copy';
    b.addEventListener('click', function () {
      copyText(text).then(function (ok) {
        if (!ok) return;
        b.textContent = S.copied || 'Copied'; b.classList.add('done');
        setTimeout(function () { b.textContent = S.copy || 'Copy'; b.classList.remove('done'); }, 1500);
      });
    });
    pre.appendChild(b);
  });
})();
