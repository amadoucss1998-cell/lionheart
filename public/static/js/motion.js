// Site-wide GSAP motion: entrance, scroll reveals, counters and card hover.
// Content is fully visible without JS; animations only start once GSAP loads.
(function () {
  var gsap = window.gsap;
  if (!gsap) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);
  document.documentElement.classList.add('motion');

  // Numbers count up when they come into view
  function counters() {
    document.querySelectorAll('[data-count]').forEach(function (el) {
      var end = Number(el.dataset.count) || 0;
      if (reduce) { el.textContent = end.toLocaleString(); return; }
      var obj = { v: 0 };
      gsap.to(obj, {
        v: end, duration: 1.6, ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 90%', once: true },
        onUpdate: function () { el.textContent = Math.round(obj.v).toLocaleString(); },
      });
    });
  }

  if (reduce) { counters(); return; }

  // Hero entrance
  var hero = document.querySelector('.hero');
  if (hero) {
    var tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from('.hero [data-anim="eyebrow"]', { y: 16, opacity: 0, duration: 0.6 })
      .from('.hero h1 .line', { yPercent: 110, opacity: 0, duration: 0.9, stagger: 0.12 }, '-=0.3')
      .from('.hero [data-anim="lead"]', { y: 20, opacity: 0, duration: 0.7 }, '-=0.5')
      .from('.hero .cta > *', { y: 16, opacity: 0, duration: 0.5, stagger: 0.08 }, '-=0.4')
      .from('.hero .hero-stats > *', { y: 16, opacity: 0, duration: 0.5, stagger: 0.08 }, '-=0.3')
      .from('.hero-legend > *', { x: 20, opacity: 0, duration: 0.5, stagger: 0.1 }, 1.2);

    // Subtle parallax as the hero scrolls away
    if (window.ScrollTrigger) {
      gsap.to('.hero-copy', { yPercent: 12, opacity: 0.4, ease: 'none', scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to('#hero-globe', { yPercent: -8, scale: 0.94, ease: 'none', scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true } });
    }
  }

  // Page intro for inner pages
  gsap.from('.page > .breadcrumbs, .page > .page-head, .page > h1', { y: 14, opacity: 0, duration: 0.6, stagger: 0.06, ease: 'power2.out' });

  if (window.ScrollTrigger) {
    // Staggered reveal for grids of cards
    var groups = ['.two-ways > *', '.cat-tile', '.pcard', '.steps .st', '.service', '.stats .stat', '.buy-option', '.grid-3 > .card', '.cart-item'];
    groups.forEach(function (sel) {
      var els = document.querySelectorAll(sel);
      if (!els.length) return;
      gsap.set(els, { y: 28, opacity: 0 });
      window.ScrollTrigger.batch(els, {
        start: 'top 92%',
        once: true,
        onEnter: function (batch) {
          gsap.to(batch, { y: 0, opacity: 1, duration: 0.55, stagger: 0.05, ease: 'power3.out', overwrite: true, clearProps: 'transform' });
        },
      });
    });

    // Section titles slide in with a gold underline
    document.querySelectorAll('.section-head h2').forEach(function (h) {
      gsap.from(h, { x: -24, opacity: 0, duration: 0.7, ease: 'power3.out', scrollTrigger: { trigger: h, start: 'top 90%', once: true } });
    });

    document.querySelectorAll('.cta-band').forEach(function (el) {
      gsap.from(el, { y: 40, opacity: 0, scale: 0.98, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 90%', once: true } });
    });

    // Route line on the "how it works" steps draws itself
    document.querySelectorAll('.steps-line path').forEach(function (p) {
      var len = p.getTotalLength();
      gsap.fromTo(p, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, ease: 'none', scrollTrigger: { trigger: p.closest('.section'), start: 'top 75%', end: 'bottom 60%', scrub: 1 } });
    });
  }

  counters();

  if (window.ScrollTrigger) {
    // Web fonts and images change the page height after the first measurement;
    // re-measure so every reveal triggers at the right scroll position.
    var refresh = function () { window.ScrollTrigger.refresh(); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
    window.addEventListener('load', refresh);
    // Safety net: anything still hidden once it is on screen is shown anyway.
    var reveal = function () {
      document.querySelectorAll('.two-ways > *, .cat-tile, .pcard, .steps .st, .service, .stats .stat, .buy-option, .grid-3 > .card, .cart-item').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0 && getComputedStyle(el).opacity === '0') {
          gsap.to(el, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', overwrite: true, clearProps: 'transform' });
        }
      });
    };
    var t;
    window.addEventListener('scroll', function () { clearTimeout(t); t = setTimeout(reveal, 250); }, { passive: true });
    setTimeout(reveal, 1500);
  }

  // 3D tilt on product and category cards (pointer devices only)
  if (window.matchMedia('(hover: hover)').matches) {
    document.querySelectorAll('.pcard').forEach(function (card) {
      gsap.set(card, { transformPerspective: 800 });
      var rx = gsap.quickTo(card, 'rotationX', { duration: 0.4, ease: 'power2.out' });
      var ry = gsap.quickTo(card, 'rotationY', { duration: 0.4, ease: 'power2.out' });
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        ry(((e.clientX - r.left) / r.width - 0.5) * 5);
        rx(-((e.clientY - r.top) / r.height - 0.5) * 5);
      });
      card.addEventListener('pointerleave', function () { rx(0); ry(0); });
    });

    // Magnetic primary buttons
    document.querySelectorAll('.btn-lg').forEach(function (btn) {
      var mx = gsap.quickTo(btn, 'x', { duration: 0.35, ease: 'power3.out' });
      var my = gsap.quickTo(btn, 'y', { duration: 0.35, ease: 'power3.out' });
      btn.addEventListener('pointermove', function (e) {
        var r = btn.getBoundingClientRect();
        mx((e.clientX - r.left - r.width / 2) * 0.18);
        my((e.clientY - r.top - r.height / 2) * 0.25);
      });
      btn.addEventListener('pointerleave', function () { mx(0); my(0); });
    });
  }

  // Header shadow once the page scrolls
  var header = document.querySelector('.header');
  if (header) {
    var onScroll = function () { header.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
