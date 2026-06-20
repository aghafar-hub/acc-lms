/* ============================================================
   ACC LMS — Shell Builder
   Builds the app navigation shell dynamically for all pages
   ============================================================ */

'use strict';

const Shell = {
  // Navigation config — role-based filtering applied at render
  _navConfig: [
    {
      section: 'main',
      labelKey: 'nav.section.main',
      items: [
        { page: 'dashboard.html',    icon: '🏠', labelKey: 'nav.dashboard',     roles: ['ADMIN','SUPERVISOR','TECHNICIAN','VIEWER'] },
        { page: 'points.html',       icon: '⚙️', labelKey: 'nav.points',        roles: ['ADMIN','SUPERVISOR','TECHNICIAN','VIEWER'] },
        { page: 'history.html',      icon: '📋', labelKey: 'nav.history',       roles: ['ADMIN','SUPERVISOR','TECHNICIAN','VIEWER'] },
        { page: 'analysis.html',     icon: '🔬', labelKey: 'nav.analysis',      roles: ['ADMIN','SUPERVISOR','TECHNICIAN','VIEWER'] },
      ],
    },
    {
      section: 'workflow',
      labelKey: 'nav.section.workflow',
      items: [
        { page: 'pending.html',      icon: '⏳', labelKey: 'nav.pending',       roles: ['ADMIN','SUPERVISOR'], badgeKey: 'pending' },
        { page: 'notifications.html',icon: '🔔', labelKey: 'nav.notifications', roles: ['ADMIN','SUPERVISOR','TECHNICIAN','VIEWER'], badgeKey: 'notif' },
      ],
    },
    {
      section: 'reports',
      labelKey: 'nav.section.analytics',
      items: [
        { page: 'reports.html',      icon: '📊', labelKey: 'nav.reports',       roles: ['ADMIN','SUPERVISOR','VIEWER'] },
      ],
    },
    {
      section: 'admin',
      labelKey: 'nav.section.admin',
      items: [
        { page: 'users.html',        icon: '👥', labelKey: 'nav.users',         roles: ['ADMIN','SUPERVISOR'] },
        { page: 'settings.html',     icon: '⚙',  labelKey: 'nav.settings',      roles: ['ADMIN','SUPERVISOR','TECHNICIAN','VIEWER'] },
      ],
    },
  ],

  async init() {
    if (!Auth.requireAuth()) return;

    const user = Auth.getUser();
    const role = Auth.getRole();

    // Build sidebar
    this._buildSidebar(user, role);

    // Build header
    this._buildHeader(user, role);

    // Build search overlay
    this._buildSearchOverlay();

    // Apply i18n
    I18n._rerender();

    // Init sidebar
    Sidebar.init();

    // Init global search
    GlobalSearch.init();

    // Init notification bell
    await NotifBell.init();

    // Start delta sync for active tabs
    SyncManager.startBackground(['LUBRICATION_POINTS', 'NOTIFICATIONS']);

    // Listen for notification updates
    EventBus.on('notif:updated', ({ count }) => {
      const badge = document.getElementById('notif-count');
      if (badge) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = count > 0 ? 'flex' : 'none';
      }
    });

    // Language change listener
    EventBus.on('lang:changed', () => I18n._rerender());
  },

  _buildSidebar(user, role) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const currentPage = window.location.pathname.split('/').pop() || 'dashboard.html';
    const contractorName = Store.get('lms_contractor', '') || '';

    sidebar.innerHTML = `
      <div class="sidebar-brand">
        <img src="../assets/logo.png" alt="ACC" class="sidebar-logo" onerror="this.style.display='none'">
        <div class="sidebar-brand-text">
          <div class="sidebar-brand-name">ARABIAN CEMENT</div>
          ${contractorName ? `<div class="sidebar-brand-sub">${contractorName}</div>` : ''}
        </div>
      </div>

      <button class="sidebar-toggle" id="sidebar-toggle" title="Toggle sidebar">◀</button>

      <nav class="sidebar-nav" id="sidebar-nav">
        ${this._renderNavSections(role, currentPage)}
      </nav>

      <div class="sidebar-footer">
        ${this._renderUserFooter(user, role)}
      </div>
    `;
  },

  _renderNavSections(role, currentPage) {
    return this._navConfig.map(section => {
      const visibleItems = section.items.filter(item => item.roles.includes(role));
      if (!visibleItems.length) return '';

      const itemsHtml = visibleItems.map(item => this._renderNavItem(item, currentPage)).join('');

      return `
        <div class="nav-section">
          <div class="nav-section-label" data-i18n="${section.labelKey}">${I18n.t(section.labelKey)}</div>
          ${itemsHtml}
        </div>
      `;
    }).join('');
  },

  _renderNavItem(item, currentPage) {
    const isActive = currentPage === item.page;
    const badgeHtml = item.badgeKey
      ? `<span class="nav-badge" id="nav-badge-${item.badgeKey}" style="display:none">0</span>`
      : '';

    return `
      <a href="${item.page}" class="nav-item ${isActive ? 'active' : ''}" data-page="${item.page}">
        <span class="nav-icon">${item.icon}</span>
        <span class="nav-label" data-i18n="${item.labelKey}">${item.labelKey}</span>
        ${badgeHtml}
      </a>
    `;
  },

  _renderUserFooter(user, role) {
    // FIX: backend returns FullNameEN/FullNameAR, never a plain 'Name'
    // field — this always fell through to the 'User' fallback before.
    const displayName = (I18n.getLang() === 'ar' ? user?.FullNameAR : user?.FullNameEN) || user?.FullNameEN || 'User';
    const initials = Format.initials(displayName);
    const roleName = { ADMIN: 'Administrator', SUPERVISOR: 'Supervisor', TECHNICIAN: 'Technician', VIEWER: 'Viewer' }[role] || role;

    return `
      <div class="sidebar-user" onclick="Shell.showUserMenu()">
        <div class="user-avatar">${initials}</div>
        <div class="user-info">
          <div class="user-name">${displayName}</div>
          <div class="user-role">${roleName}</div>
        </div>
        <button class="user-logout-btn" onclick="event.stopPropagation(); Auth.logout();" title="Sign Out">⏻</button>
      </div>
    `;
  },

  _buildHeader(user, role) {
    const header = document.getElementById('app-header');
    if (!header) return;

    const pageTitle = document.title.split('—')[0].trim() || 'LMS';

    header.innerHTML = `
      <!-- Mobile menu button -->
      <button class="btn-icon" id="mobile-menu-btn" aria-label="Open menu">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/>
        </svg>
      </button>

      <!-- Page title -->
      <div class="flex-1 min-w-0">
        <h1 class="text-xl font-semibold truncate" id="page-title">${pageTitle}</h1>
        <div class="text-xs text-muted" id="page-breadcrumb"></div>
      </div>

      <!-- Header actions -->
      <div class="flex items-center gap-2">

        <!-- Global Search -->
        <button class="btn btn-ghost btn-sm" id="global-search-btn" title="Search (Ctrl+K)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="7" cy="7" r="5"/><line x1="11" y1="11" x2="15" y2="15"/>
          </svg>
          <span class="hidden-mobile">Search</span>
          <kbd style="font-size:10px;background:var(--color-bg);padding:1px 5px;border-radius:4px;border:1px solid var(--color-border);margin-left:4px;" class="hidden-mobile">Ctrl K</kbd>
        </button>

        <!-- Language toggle -->
        <button class="btn btn-ghost btn-sm" id="lang-toggle-btn" onclick="Shell.toggleLang()" title="Switch Language">
          <span id="current-lang-label">${I18n.getLang() === 'ar' ? 'EN' : 'عربي'}</span>
        </button>

        <!-- Notifications bell -->
        <div style="position:relative;">
          <button class="btn btn-ghost btn-sm notif-badge" onclick="window.location.href='notifications.html'">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            <span class="notif-count" id="notif-count" style="display:none">0</span>
          </button>
        </div>

        <!-- User avatar/menu -->
        <div style="position:relative;" id="user-menu-wrapper">
          <div class="user-avatar" style="cursor:pointer;width:34px;height:34px;font-size:13px;background:var(--color-brand-navy);color:#fff;border:none;"
            onclick="Shell.toggleUserDropdown()">
            ${Format.initials((I18n.getLang() === 'ar' ? user?.FullNameAR : user?.FullNameEN) || user?.FullNameEN || '?')}
          </div>
          <div class="dropdown-menu" id="user-dropdown" style="display:none;min-width:200px;">
            <div style="padding:12px 16px;border-bottom:1px solid var(--color-border);">
              <div style="font-weight:600;font-size:var(--text-sm)">${(I18n.getLang() === 'ar' ? user?.FullNameAR : user?.FullNameEN) || user?.FullNameEN || ''}</div>
              <div style="font-size:var(--text-xs);color:var(--color-text-muted)">${user?.EmployeeNo || ''} · ${role}</div>
            </div>
            <button class="dropdown-item" onclick="window.location.href='settings.html'">⚙ Settings</button>
            <button class="dropdown-item" onclick="Shell.showChangePassword()">🔑 Change Password</button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item danger" onclick="Auth.logout()">⏻ Sign Out</button>
          </div>
        </div>
      </div>

      <!-- Mobile overlay -->
      <div id="mobile-overlay" style="display:none;" class="mobile-overlay"></div>
    `;

    // Close dropdown on outside click
    document.addEventListener('click', e => {
      if (!document.getElementById('user-menu-wrapper')?.contains(e.target)) {
        document.getElementById('user-dropdown').style.display = 'none';
      }
    });
  },

  _buildSearchOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'search-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'display:none;align-items:flex-start;padding-top:80px;';
    overlay.innerHTML = `
      <div style="background:var(--color-surface);border-radius:var(--radius-xl);width:100%;max-width:600px;box-shadow:var(--shadow-xl);overflow:hidden;">
        <div style="display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--color-border);">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-muted)" stroke-width="2">
            <circle cx="7" cy="7" r="5"/><line x1="11" y1="11" x2="15" y2="15"/>
          </svg>
          <input type="text" id="search-input" class="form-control"
            placeholder="${I18n.t('search.placeholder')}"
            style="border:none;box-shadow:none;padding:0;font-size:var(--text-md);">
          <button id="search-close" class="btn-icon" onclick="GlobalSearch.close()">✕</button>
        </div>
        <div id="search-results" style="max-height:400px;overflow-y:auto;"></div>
        <div style="padding:8px 16px;font-size:var(--text-xs);color:var(--color-text-muted);border-top:1px solid var(--color-border);">
          Press <kbd style="background:var(--color-bg);padding:1px 5px;border-radius:3px;border:1px solid var(--color-border);">ESC</kbd> to close
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  toggleUserDropdown() {
    const dd = document.getElementById('user-dropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  },

  async toggleLang() {
    const newLang = I18n.getLang() === 'en' ? 'ar' : 'en';
    await I18n.setLang(newLang);
    document.getElementById('current-lang-label').textContent = newLang === 'ar' ? 'EN' : 'عر';
  },

  showUserMenu() {
    // Mobile user menu — currently logs out
    // Can be extended to show profile page
  },

  showChangePassword() {
    document.getElementById('user-dropdown').style.display = 'none';
    const modalId = Modal.create({
      title: I18n.t('change_password'),
      body: `
        <form id="header-pwd-form" class="login-form" novalidate style="gap:16px;">
          <div class="form-group">
            <label class="form-label required">Current Password</label>
            <input type="password" id="curr-pwd" class="form-control" placeholder="Current password">
          </div>
          <div class="form-group">
            <label class="form-label required">New Password</label>
            <input type="password" id="hdr-new-pwd" class="form-control" placeholder="Min. 8 characters">
          </div>
          <div class="form-group">
            <label class="form-label required">Confirm New Password</label>
            <input type="password" id="hdr-confirm-pwd" class="form-control" placeholder="Repeat password">
          </div>
          <div class="login-error" id="hdr-pwd-error"><span>⚠</span><span id="hdr-pwd-error-text"></span></div>
        </form>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="Modal.close('${modalId}')">Cancel</button>
        <button class="btn btn-primary" onclick="Shell.doChangePassword('${modalId}')">Update Password</button>
      `,
    });
  },

  async doChangePassword(modalId) {
    const curr = document.getElementById('curr-pwd')?.value || '';
    const newp = document.getElementById('hdr-new-pwd')?.value || '';
    const conf = document.getElementById('hdr-confirm-pwd')?.value || '';

    if (newp.length < 8) {
      document.getElementById('hdr-pwd-error-text').textContent = I18n.t('login.password_too_short');
      document.getElementById('hdr-pwd-error').classList.add('visible');
      return;
    }
    if (newp !== conf) {
      document.getElementById('hdr-pwd-error-text').textContent = I18n.t('login.passwords_mismatch');
      document.getElementById('hdr-pwd-error').classList.add('visible');
      return;
    }

    const res = await API.changePassword(curr, newp);
    if (res.success) {
      Modal.close(modalId);
      Toast.success(I18n.t('msg.saved'));
    } else {
      document.getElementById('hdr-pwd-error-text').textContent = res.error || I18n.t('error.generic');
      document.getElementById('hdr-pwd-error').classList.add('visible');
    }
  },
};

// Inject hidden-mobile utility CSS
const _shellStyle = document.createElement('style');
_shellStyle.textContent = `
@media (max-width: 640px) {
  .hidden-mobile { display: none !important; }
}
`;
document.head.appendChild(_shellStyle);
