(() => {
  'use strict';

  const TABS = ['home', 'concepts', 'install', 'docs'];
  const GITHUB_URL = 'https://github.com/MicroMediaSites/think-cli';

  const SIDEBAR = {
    home: {
      groups: [
        { label: 'overview', items: [
          { label: 'problem', href: '#problem' },
          { label: 'the fix', href: '#solution' },
          { label: 'next', href: '#next' },
        ]},
        { label: 'jump to', items: [
          { label: 'concepts', tab: 'concepts' },
          { label: 'install', tab: 'install' },
          { label: 'docs', tab: 'docs' },
        ]},
        { label: 'links', items: [
          { label: 'github', href: GITHUB_URL, external: true },
          { label: 'npm', href: 'https://www.npmjs.com/package/open-think', external: true },
        ]},
      ],
    },
    concepts: {
      groups: [
        { label: 'pipeline', items: [
          { label: '01 entries', href: '#c1' },
          { label: '02 engrams', href: '#c2' },
          { label: '03 cortex',  href: '#c3' },
          { label: '04 curator', href: '#c4' },
          { label: '05 recall',  href: '#c5' },
        ]},
        { label: 'design', items: [
          { label: 'architecture', href: '#arch' },
        ]},
      ],
    },
    install: {
      groups: [
        { label: 'steps', items: [
          { label: '1. install',    href: '#s1' },
          { label: '2. log',        href: '#s2' },
          { label: '3. cortex',     href: '#s3' },
          { label: '4. agents',     href: '#s4' },
          { label: '5. curate',     href: '#s5' },
        ]},
        { label: 'related', items: [
          { label: 'agent setup', href: '#agents' },
        ]},
      ],
    },
    docs: {
      groups: [
        { label: 'reference', items: [
          { label: 'all commands', href: '#commands' },
          { label: 'where things live', href: '#files' },
        ]},
        { label: 'links', items: [
          { label: 'github', href: GITHUB_URL, external: true },
          { label: 'npm', href: 'https://www.npmjs.com/package/open-think', external: true },
          { label: 'issues', href: GITHUB_URL + '/issues', external: true },
        ]},
      ],
    },
  };

  const tabsEl = document.querySelectorAll('.tab');
  const viewsEl = document.querySelectorAll('.view');
  const sidebarNav = document.getElementById('sidebar-nav');
  const helpModal = document.getElementById('help-modal');

  let currentTab = 'home';
  let sidebarFocusIndex = -1;

  function renderSidebar(tab) {
    const config = SIDEBAR[tab];
    const html = config.groups.map(group => {
      const items = group.items.map((item, i) => {
        const last = i === group.items.length - 1 ? ' last' : '';
        if (item.tab) {
          return `<a href="#" class="nav-link${last}" data-goto="${item.tab}">${item.label}</a>`;
        }
        const ext = item.external ? ' target="_blank" rel="noopener"' : '';
        return `<a href="${item.href}" class="nav-link${last}"${ext}>${item.label}</a>`;
      }).join('');
      return `<div class="group">${group.label}</div>${items}`;
    }).join('');
    sidebarNav.innerHTML = html;
    sidebarFocusIndex = -1;
  }

  function setTab(tab, opts = {}) {
    if (!TABS.includes(tab)) return;
    currentTab = tab;
    tabsEl.forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    viewsEl.forEach(el => el.classList.toggle('active', el.dataset.view === tab));
    renderSidebar(tab);
    if (opts.updateHash !== false) {
      history.replaceState(null, '', '#' + tab);
    }
    if (opts.scrollTop !== false) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }

  // Tab clicks
  tabsEl.forEach(tab => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  });

  // Internal navigation links (data-goto)
  document.addEventListener('click', e => {
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      e.preventDefault();
      setTab(goto.dataset.goto);
    }
  });

  // Initial state from hash
  const initialHash = location.hash.slice(1);
  setTab(TABS.includes(initialHash) ? initialHash : 'home', { scrollTop: false });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    // Skip when typing in inputs or modal is open with focus
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const navLinks = sidebarNav.querySelectorAll('.nav-link');

    // Modal handling
    if (!helpModal.hidden) {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        helpModal.hidden = true;
        return;
      }
      return;
    }

    switch (e.key) {
      case 'h': setTab('home'); break;
      case 'c': setTab('concepts'); break;
      case 'i': setTab('install'); break;
      case 'd': setTab('docs'); break;
      case 'g':
        window.open(GITHUB_URL, '_blank', 'noopener');
        break;
      case '?':
        helpModal.hidden = false;
        break;
      case 'Escape':
        if (!helpModal.hidden) helpModal.hidden = true;
        break;
      case 'ArrowDown':
        e.preventDefault();
        sidebarFocusIndex = Math.min(sidebarFocusIndex + 1, navLinks.length - 1);
        navLinks[sidebarFocusIndex]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        sidebarFocusIndex = Math.max(sidebarFocusIndex - 1, 0);
        navLinks[sidebarFocusIndex]?.focus();
        break;
      case 'Enter':
        if (document.activeElement?.classList.contains('nav-link')) {
          // anchor click works natively, no override needed
        }
        break;
    }
  });

  // Modal close button
  helpModal.querySelector('.modal-close').addEventListener('click', () => {
    helpModal.hidden = true;
  });
  helpModal.addEventListener('click', e => {
    if (e.target === helpModal) helpModal.hidden = true;
  });

  // Hashchange (back/forward navigation)
  window.addEventListener('hashchange', () => {
    const hash = location.hash.slice(1);
    if (TABS.includes(hash) && hash !== currentTab) {
      setTab(hash, { updateHash: false });
    }
  });

  // Highlight active sidebar item based on scroll position (within current view)
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        sidebarNav.querySelectorAll('.nav-link').forEach(a => {
          a.classList.toggle('current', a.getAttribute('href') === '#' + id);
        });
      }
    });
  }, { rootMargin: '-20% 0px -60% 0px' });

  document.querySelectorAll('[id]').forEach(el => {
    if (el.closest('.view')) observer.observe(el);
  });

  // Fetch latest published version from npm registry
  fetch('https://registry.npmjs.org/open-think/latest')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data?.version) return;
      const label = 'v' + data.version;
      document.getElementById('version-pill')?.replaceChildren(document.createTextNode(label));
      document.getElementById('version-badge')?.replaceChildren(document.createTextNode(label));
    })
    .catch(() => {});

})();
