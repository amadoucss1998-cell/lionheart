(function () {
  // Load the 3D globe only after the page has finished loading and the browser
  // is idle, so it never delays text, buttons or images. Skipped on data saver.
  var globe = document.getElementById('hero-globe');
  if (globe && globe.dataset.src) {
    var saveData = navigator.connection && navigator.connection.saveData;
    var start = function () { import(globe.dataset.src).catch(function () {}); };
    var whenIdle = function () { (window.requestIdleCallback || function (f) { setTimeout(f, 200); })(start, { timeout: 2500 }); };
    if (!saveData) {
      if (document.readyState === 'complete') whenIdle();
      else window.addEventListener('load', whenIdle);
    }
  }

  // Product gallery thumbnails
  document.querySelectorAll('[data-gallery]').forEach(function (g) {
    var main = g.querySelector('.main img');
    g.querySelectorAll('.thumbs button').forEach(function (b) {
      b.addEventListener('click', function () {
        main.src = b.dataset.src;
        g.querySelectorAll('.thumbs button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
      });
    });
  });

  // Confirmation prompts for destructive actions
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.confirm(f.dataset.confirm)) e.preventDefault();
    });
  });

  // Preview selected images before upload
  document.querySelectorAll('input[type=file][data-preview]').forEach(function (input) {
    var box = document.getElementById(input.dataset.preview);
    input.addEventListener('change', function () {
      box.innerHTML = '';
      Array.prototype.slice.call(input.files || []).forEach(function (file) {
        if (!/^image\//.test(file.type)) return;
        var img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.alt = file.name;
        box.appendChild(img);
      });
    });
  });

  // Auto-submit selects (catalog sort, filters)
  document.querySelectorAll('select[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });

  // Admin sidebar toggle on mobile
  // Admin menu on phones: open with the menu button; close with the ✕ button,
  // by tapping outside it, with Escape, or by following a link.
  var toggle = document.querySelector('[data-toggle-side]');
  var side = document.querySelector('.admin-side');
  var backdrop = document.querySelector('.admin-backdrop');
  if (toggle && side) {
    var setOpen = function (open) {
      side.classList.toggle('open', open);
      if (backdrop) backdrop.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.style.overflow = open ? 'hidden' : '';
    };
    toggle.addEventListener('click', function () { setOpen(!side.classList.contains('open')); });
    document.querySelectorAll('[data-close-side]').forEach(function (el) { el.addEventListener('click', function () { setOpen(false); }); });
    side.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { setOpen(false); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && side.classList.contains('open')) setOpen(false); });
  }

  // Quote calculator in admin order page
  var qf = document.querySelector('[data-quote-form]');
  if (qf) {
    var recalc = function () {
      var goods = 0;
      qf.querySelectorAll('[data-line]').forEach(function (row) {
        var qty = Number(row.dataset.qty) || 0;
        var price = Number(row.querySelector('input').value) || 0;
        var t = qty * price;
        goods += t;
        row.querySelector('[data-line-total]').textContent = t ? t.toFixed(2) : '—';
      });
      var ship = Number(qf.querySelector('[name=shipping_cost]').value) || 0;
      var other = Number(qf.querySelector('[name=other_charges]').value) || 0;
      qf.querySelector('[data-goods]').textContent = goods.toFixed(2);
      qf.querySelector('[name=quoted_total]').placeholder = (goods + ship + other).toFixed(2);
    };
    qf.addEventListener('input', recalc);
    recalc();
  }
})();

// Shrink large photos in the browser before uploading: faster on mobile data
// and keeps each form under the hosting upload limit (4.5 MB on Vercel).
(function () {
  var MAX_SIDE = 1800;
  var QUALITY = 0.85;
  var SKIP_BELOW = 700 * 1024;
  var LIMIT = 4.3 * 1024 * 1024;
  if (!window.DataTransfer || !window.HTMLCanvasElement) return;

  function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < SKIP_BELOW) return Promise.resolve(file);
    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          if (!blob || blob.size >= file.size) return resolve(file);
          resolve(new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
        }, 'image/jpeg', QUALITY);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  document.querySelectorAll('form[enctype="multipart/form-data"]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (form.dataset.resized) return;
      var inputs = Array.prototype.slice.call(form.querySelectorAll('input[type=file][accept^="image"]')).filter(function (i) { return i.files && i.files.length; });
      if (!inputs.length) return;
      e.preventDefault();
      var submitter = e.submitter;
      var buttons = form.querySelectorAll('button[type=submit]');
      buttons.forEach(function (b) { b.disabled = true; });
      Promise.all(inputs.map(function (input) {
        return Promise.all(Array.prototype.map.call(input.files, shrink)).then(function (files) {
          var dt = new DataTransfer();
          files.forEach(function (f) { dt.items.add(f); });
          input.files = dt.files;
          return files.reduce(function (n, f) { return n + f.size; }, 0);
        });
      })).then(function (sizes) {
        buttons.forEach(function (b) { b.disabled = false; });
        var total = sizes.reduce(function (a, b) { return a + b; }, 0);
        if (total > LIMIT) {
          window.alert('These photos are too large to upload together (' + (total / 1048576).toFixed(1) + ' MB). Please upload fewer photos at a time.');
          return;
        }
        form.dataset.resized = '1';
        if (form.requestSubmit) form.requestSubmit(submitter || undefined);
        else form.submit();
      });
    });
  });
})();
