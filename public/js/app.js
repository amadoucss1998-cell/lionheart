(function () {
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
  var toggle = document.querySelector('[data-toggle-side]');
  if (toggle) toggle.addEventListener('click', function () { document.querySelector('.admin-side').classList.toggle('open'); });

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
