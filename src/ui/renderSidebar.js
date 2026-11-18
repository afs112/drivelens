import { getLocaleTag, t } from '../i18n.js';
import { escapeAttr, escapeHtml, icon } from './icons.js';

function getInitial(name) {
  const s = String(name || '?').trim();
  return s ? s[0].toUpperCase() : '?';
}

function renderFolderTree(store, state) {
  const { folders, activeFolderId, includeSubfolders } = state;
  if (!folders || folders.length === 0) {
    return `<div class="form-help" style="padding:4px 8px">${escapeHtml(t('sidebar.noFolders'))}</div>`;
  }

  // Build ordered tree DFS
  const byParent = new Map();
  for (const f of folders) {
    const pid = f.parentId || '__root__';
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(f);
  }
  const locale = getLocaleTag();
  for (const list of byParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, locale));
  }

  const ordered = [];
  function walk(parentKey, level) {
    const children = byParent.get(parentKey) || [];
    for (const child of children) {
      ordered.push({ folder: child, level });
      walk(child.id, level + 1);
    }
  }
  walk('__root__', 0);

  return ordered
    .map(({ folder, level }) => {
      const isActive = activeFolderId === folder.id;
      const count = store.getFolderPhotoCount(folder.id, includeSubfolders || folder.depth === 0);
      const padLeft = 8 + level * 14;
      return `
        <button
          type="button"
          class="nav-item ${isActive ? 'active' : ''}"
          style="padding-left:${padLeft}px"
          data-action="select-folder"
          data-folder-id="${escapeAttr(folder.id)}"
          title="${escapeAttr(folder.name)}"
        >
          <span class="nav-item-main">
            ${icon(isActive ? 'folderOpen' : 'folder', 15)}
            <span class="nav-item-label">${escapeHtml(folder.name)}</span>
          </span>
          <span class="nav-count">${count}</span>
        </button>
      `;
    })
    .join('');
}

function renderTagManager(store, state) {
  const tags = store.getActiveTagList();
  const counts = store.getTagCounts();

  if (tags.length === 0) {
    return `
      <div class="form-help" style="padding:4px 8px">
        ${escapeHtml(t('sidebar.noTagsHint'))}
      </div>
    `;
  }

  const grouped = new Map();
  for (const tItem of tags) {
    const g = tItem.group || t('sidebar.ungrouped');
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(tItem);
  }

  let html = '';
  for (const [groupName, groupTags] of grouped.entries()) {
    html += `<div class="tag-group-block">
      <div class="tag-group-title">${escapeHtml(groupName)}</div>`;
    for (const tItem of groupTags) {
      const active = state.selectedTagIds.has(tItem.id);
      const count = counts[tItem.id] || 0;
      html += `
        <div
          class="tag-row ${active ? 'active' : ''}"
          data-action="toggle-tag-filter"
          data-tag-id="${escapeAttr(tItem.id)}"
          role="button"
          tabindex="0"
        >
          <span class="tag-row-left">
            <span class="tag-dot tag-color-${escapeAttr(tItem.color || 'blue')}"></span>
            <span class="nav-item-label">${escapeHtml(tItem.name)}</span>
          </span>
          <span class="nav-count tag-row-count">${count}</span>
          <span class="tag-row-actions">
            <button
              type="button"
              class="tag-icon-btn"
              title="${escapeAttr(t('sidebar.editTag'))}"
              data-action="edit-tag"
              data-tag-id="${escapeAttr(tItem.id)}"
            >${icon('edit', 12)}</button>
            <button
              type="button"
              class="tag-icon-btn"
              title="${escapeAttr(t('sidebar.deleteTag'))}"
              data-action="delete-tag"
              data-tag-id="${escapeAttr(tItem.id)}"
            >${icon('trash', 12)}</button>
          </span>
        </div>
      `;
    }
    html += `</div>`;
  }
  return html;
}

export function renderSidebar(container, store) {
  if (!container) return;
  const state = store.state;
  const members = store.getMembersSummary();

  const totalCount = state.files.length;
  let favTotal = 0;
  let unratedTotal = 0;
  for (const f of state.files) {
    const m = store.getAggregatedItemMeta(f.id);
    if (m.favoriteCount > 0) favTotal += 1;
    if (m.ratingCount === 0) unratedTotal += 1;
  }

  container.classList.toggle('collapsed', Boolean(state.sidebarCollapsed) && !state.sidebarOpen);

  container.innerHTML = `
    <div class="sidebar-scroll">
      <!-- Quick Views -->
      <div class="sidebar-section">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.quickViews'))}</span>
        </div>
        <button type="button" class="nav-item ${state.quickView === 'all' ? 'active' : ''}" data-action="quick-view" data-view="all">
          <span class="nav-item-main">${icon('image', 15)}<span class="nav-item-label">${escapeHtml(t('sidebar.allMedia'))}</span></span>
          <span class="nav-count">${totalCount}</span>
        </button>
        <button type="button" class="nav-item ${state.quickView === 'favorites' ? 'active' : ''}" data-action="quick-view" data-view="favorites">
          <span class="nav-item-main" style="color:${state.quickView === 'favorites' ? 'var(--heart-rose)' : 'inherit'}">${icon('heartFilled', 15)}<span class="nav-item-label">${escapeHtml(t('sidebar.favorites'))}</span></span>
          <span class="nav-count">${favTotal}</span>
        </button>
        <button type="button" class="nav-item ${state.quickView === 'unrated' ? 'active' : ''}" data-action="quick-view" data-view="unrated">
          <span class="nav-item-main">${icon('star', 15)}<span class="nav-item-label">${escapeHtml(t('sidebar.unrated'))}</span></span>
          <span class="nav-count">${unratedTotal}</span>
        </button>
      </div>

      <!-- Folder Tree -->
      <div class="sidebar-section">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.folders'))}</span>
        </div>
        <div class="subfolder-toggle">
          <label class="switch-label">
            <input type="checkbox" id="toggleSubfoldersCheck" ${state.includeSubfolders ? 'checked' : ''} />
            <span>${escapeHtml(t('sidebar.includeSubfolders'))}</span>
          </label>
        </div>
        <div class="folder-tree">
          ${renderFolderTree(store, state)}
        </div>
      </div>

      <!-- Rating Filter -->
      <div class="sidebar-section">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.ratingFilter'))}</span>
          ${
            state.minRating > 0
              ? `<button type="button" class="btn btn-ghost btn-sm" style="height:20px;padding:0 6px" data-action="set-min-rating" data-rating="0">${escapeHtml(t('sidebar.reset'))}</button>`
              : ''
          }
        </div>
        <div class="segmented" style="margin:0 4px">
          <button type="button" class="seg-btn ${state.ratingScope === 'avg' ? 'active' : ''}" data-action="set-rating-scope" data-scope="avg">${escapeHtml(t('sidebar.scopeAvg'))}</button>
          <button type="button" class="seg-btn ${state.ratingScope === 'mine' ? 'active' : ''}" data-action="set-rating-scope" data-scope="mine">${escapeHtml(t('sidebar.scopeMine'))}</button>
          <button type="button" class="seg-btn ${state.ratingScope === 'member' ? 'active' : ''}" data-action="set-rating-scope" data-scope="member">${escapeHtml(t('sidebar.scopeMember'))}</button>
        </div>
        <div class="star-filter-row" style="padding:2px 4px 0">
          ${[0, 1, 2, 3, 4, 5]
            .map(
              (r) => `
            <button
              type="button"
              class="star-pill ${state.minRating === r ? 'active' : ''}"
              data-action="set-min-rating"
              data-rating="${r}"
              title="${escapeAttr(r === 0 ? t('sidebar.allStarsTitle') : t('sidebar.minStarsTitle', { n: r }))}"
            >${r === 0 ? escapeHtml(t('sidebar.allStars')) : `${r}★`}</button>
          `
            )
            .join('')}
        </div>
      </div>

      <!-- Collaborators Filter -->
      <div class="sidebar-section">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.collaborators', { count: members.length }))}</span>
        </div>
        ${members
          .map((m) => {
            const isSelected = state.ratingScope === 'member' && state.memberFilterId === m.id;
            const isMe = m.id === state.currentUser.id;
            return `
            <button
              type="button"
              class="nav-item ${isSelected ? 'active' : ''}"
              data-action="filter-member"
              data-member-id="${escapeAttr(m.id)}"
              title="${escapeAttr(t('sidebar.memberTitle', { name: m.name }))}"
            >
              <span class="nav-item-main">
                <span class="member-avatar" style="background:${escapeAttr(m.color)}">
                  ${m.picture ? `<img src="${escapeAttr(m.picture)}" alt="" />` : escapeHtml(getInitial(m.name))}
                </span>
                <span class="nav-item-label">${escapeHtml(m.name)}${isMe ? escapeHtml(t('sidebar.meSuffix')) : ''}</span>
              </span>
              <span class="nav-count">${m.ratedCount}★</span>
            </button>
          `;
          })
          .join('')}
      </div>

      <!-- Grouped Tag Management System -->
      <div class="sidebar-section">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.tagManager'))}</span>
          <span class="sidebar-section-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              style="height:20px;padding:0 6px;font-size:10.5px"
              data-action="toggle-tag-mode"
              title="${escapeAttr(t('sidebar.tagModeTitle'))}"
            >${escapeHtml(state.tagMatchMode === 'AND' ? t('sidebar.tagModeAnd') : t('sidebar.tagModeOr'))}</button>
            <button
              type="button"
              class="tag-icon-btn"
              title="${escapeAttr(t('sidebar.newTag'))}"
              data-action="new-tag"
            >${icon('plus', 14)}</button>
          </span>
        </div>
        ${renderTagManager(store, state)}
      </div>
    </div>
  `;
}

export function bindSidebarEvents(container, store) {
  if (!container) return;

  container.addEventListener('change', (e) => {
    if (e.target.id === 'toggleSubfoldersCheck') {
      store.setState({ includeSubfolders: e.target.checked });
    }
  });

  container.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'select-folder') {
      store.setState({ activeFolderId: target.dataset.folderId, sidebarOpen: false });
      return;
    }
    if (action === 'quick-view') {
      store.setState({ quickView: target.dataset.view, sidebarOpen: false });
      return;
    }
    if (action === 'set-rating-scope') {
      const scope = target.dataset.scope;
      const memberId =
        scope === 'member'
          ? store.state.memberFilterId || store.getMembersSummary()[0]?.id || null
          : null;
      store.setState({ ratingScope: scope, memberFilterId: memberId });
      return;
    }
    if (action === 'set-min-rating') {
      store.setState({ minRating: Number(target.dataset.rating || 0) });
      return;
    }
    if (action === 'filter-member') {
      const memberId = target.dataset.memberId;
      const already =
        store.state.ratingScope === 'member' && store.state.memberFilterId === memberId;
      if (already) {
        store.setState({ ratingScope: 'avg', memberFilterId: null });
      } else {
        store.setState({ ratingScope: 'member', memberFilterId: memberId, sidebarOpen: false });
      }
      return;
    }
    if (action === 'toggle-tag-mode') {
      store.setState({ tagMatchMode: store.state.tagMatchMode === 'AND' ? 'OR' : 'AND' });
      return;
    }
    if (action === 'new-tag') {
      store.openModal('tagEditor', null);
      return;
    }
    if (action === 'edit-tag') {
      e.stopPropagation();
      const tag = store.state.tagSchema?.tags?.[target.dataset.tagId];
      if (tag) store.openModal('tagEditor', tag);
      return;
    }
    if (action === 'delete-tag') {
      e.stopPropagation();
      const tag = store.state.tagSchema?.tags?.[target.dataset.tagId];
      if (tag && window.confirm(t('sidebar.confirmDeleteTag', { name: tag.name }))) {
        store.deleteTagDefinition(tag.id);
      }
      return;
    }
    if (action === 'toggle-tag-filter') {
      store.toggleTagFilter(target.dataset.tagId);
    }
  });
}
