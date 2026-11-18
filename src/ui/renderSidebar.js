import { getLocaleTag, t } from '../i18n.js';
import { escapeAttr, escapeHtml, icon, starSectorIcon } from './icons.js';

const objRefIds = new WeakMap();
let nextObjRefId = 1;
let lastSidebarSignature = '';

const SCOPE_INDEX_MAP = {
  avg: 0,
  mine: 1,
  member: 2,
};

function getRefId(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let id = objRefIds.get(obj);
  if (!id) {
    id = nextObjRefId;
    nextObjRefId += 1;
    objRefIds.set(obj, id);
  }
  return id;
}

function getInitial(name) {
  const s = String(name || '?').trim();
  return s ? s[0].toUpperCase() : '?';
}

function parseSortParts(sortBy = 'dateDesc') {
  if (sortBy.startsWith('rating')) return { field: 'rating', asc: sortBy.endsWith('Asc') };
  if (sortBy.startsWith('name')) return { field: 'name', asc: !sortBy.endsWith('Desc') };
  if (sortBy.startsWith('size')) return { field: 'size', asc: sortBy.endsWith('Asc') };
  return { field: 'date', asc: sortBy === 'dateAsc' };
}

function buildSortValue(field, asc) {
  if (field === 'rating') return asc ? 'ratingAsc' : 'ratingDesc';
  if (field === 'name') return asc ? 'nameAsc' : 'nameDesc';
  if (field === 'size') return asc ? 'sizeAsc' : 'sizeDesc';
  return asc ? 'dateAsc' : 'dateDesc';
}

function renderFolderTree(store, state) {
  const { folders, activeFolderId, includeSubfolders } = state;
  if (!folders || folders.length === 0) {
    return `<div class="form-help" style="padding:4px 8px">${escapeHtml(t('sidebar.noFolders'))}</div>`;
  }

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

  const directCounts = new Map();
  for (const file of state.files) {
    if (file.parentId) {
      directCounts.set(file.parentId, (directCounts.get(file.parentId) || 0) + 1);
    }
  }
  const subtreeCounts = new Map(directCounts);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const f = ordered[i].folder;
    const total = subtreeCounts.get(f.id) || 0;
    if (f.parentId && total > 0) {
      subtreeCounts.set(f.parentId, (subtreeCounts.get(f.parentId) || 0) + total);
    }
  }

  return ordered
    .map(({ folder, level }) => {
      const isActive = activeFolderId === folder.id;
      const includeChildren = includeSubfolders || folder.depth === 0;
      const count = includeChildren
        ? subtreeCounts.get(folder.id) || 0
        : directCounts.get(folder.id) || 0;
      const padLeft = 10 + level * 14;
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
  const isCollapsed = !state.sidebarOpen;
  container.classList.toggle('collapsed', isCollapsed);
  container.inert = isCollapsed;
  if (isCollapsed && container.childElementCount > 0) return;

  const selectedTagsKey =
    state.selectedTagIds && state.selectedTagIds.size > 0
      ? Array.from(state.selectedTagIds).sort().join(',')
      : '';
  const sig = [
    state.lang,
    state.mode,
    state.files.length,
    state.folders.length,
    state.activeFolderId || '',
    state.includeSubfolders ? 1 : 0,
    state.quickView,
    state.mediaFilter || 'all',
    state.aspectFilter || 'all',
    state.sortBy,
    state.minRating,
    state.ratingScope,
    state.memberFilterId || '',
    selectedTagsKey,
    state.tagMatchMode,
    state.currentUser?.id || '',
    getRefId(state.files),
    getRefId(state.folders),
    getRefId(state.membersData),
    getRefId(state.tagSchema),
  ].join('|');

  if (sig === lastSidebarSignature && container.childElementCount > 0) {
    return;
  }
  lastSidebarSignature = sig;

  const members = store.getMembersSummary();
  const totalCount = state.files.length;
  let favTotal = 0;
  let unratedTotal = 0;
  for (const f of state.files) {
    const m = store.getAggregatedItemMeta(f.id);
    if (m.favoriteCount > 0) favTotal += 1;
    if (m.ratingCount === 0) unratedTotal += 1;
  }

  const hasActiveFilters =
    state.quickView !== 'all' ||
    (state.mediaFilter && state.mediaFilter !== 'all') ||
    (state.aspectFilter && state.aspectFilter !== 'all') ||
    state.minRating > 0 ||
    Boolean(state.memberFilterId) ||
    (state.selectedTagIds?.size || 0) > 0;

  const scopeIndex = String(SCOPE_INDEX_MAP[state.ratingScope] ?? 0);
  const { field: sortField, asc: sortAsc } = parseSortParts(state.sortBy);

  container.innerHTML = `
    <div class="mobile-drawer-header">
      <span>${escapeHtml(t('mobile.sidebarTitle'))}</span>
      <div class="sidebar-header-actions">
        ${
          hasActiveFilters
            ? `<button type="button" class="filter-reset-pill" data-action="reset-filters">${icon('undo', 12)}<span>${escapeHtml(t('sidebar.reset'))}</span></button>`
            : ''
        }
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm"
          data-action="close-sidebar"
          aria-label="${escapeAttr(t('mobile.closeDrawer'))}"
        >${icon('x', 16)}</button>
      </div>
    </div>

    <div class="sidebar-scroll">
      <!-- Quick Views & Media/Framing -->
      <div class="sidebar-section filter-glass-card">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.quickViews'))}</span>
        </div>
        <button type="button" class="nav-item ${state.quickView === 'all' ? 'active' : ''}" data-action="quick-view" data-view="all">
          <span class="nav-item-main">${icon('image', 15)}<span class="nav-item-label">${escapeHtml(t('sidebar.allMedia'))}</span></span>
          <span class="nav-count">${totalCount}</span>
        </button>
        <button type="button" class="nav-item ${state.quickView === 'favorites' ? 'active' : ''}" data-action="quick-view" data-view="favorites">
          <span class="nav-item-main">${icon(state.quickView === 'favorites' ? 'heartFilled' : 'heart', 15)}<span class="nav-item-label">${escapeHtml(t('sidebar.favorites'))}</span></span>
          <span class="nav-count">${favTotal}</span>
        </button>
        <button type="button" class="nav-item ${state.quickView === 'unrated' ? 'active' : ''}" data-action="quick-view" data-view="unrated">
          <span class="nav-item-main">${starSectorIcon(0, 15)}<span class="nav-item-label">${escapeHtml(t('sidebar.unrated'))}</span></span>
          <span class="nav-count">${unratedTotal}</span>
        </button>

        <div class="sidebar-facet-pills">
          <button type="button" class="omni-pill ${(state.mediaFilter || 'all') === 'photo' ? 'is-active' : ''}" data-action="set-media" data-media="photo">${icon('image', 12)}<span>${escapeHtml(t('search.mediaPhotos'))}</span></button>
          <button type="button" class="omni-pill ${(state.mediaFilter || 'all') === 'video' ? 'is-active' : ''}" data-action="set-media" data-media="video">${icon('video', 12)}<span>${escapeHtml(t('search.mediaVideos'))}</span></button>
          <button type="button" class="omni-pill ${(state.aspectFilter || 'all') === 'landscape' ? 'is-active' : ''}" data-action="set-aspect" data-aspect="landscape">${icon('landscape', 12)}<span>${escapeHtml(t('search.aspectLandscape'))}</span></button>
          <button type="button" class="omni-pill ${(state.aspectFilter || 'all') === 'portrait' ? 'is-active' : ''}" data-action="set-aspect" data-aspect="portrait">${icon('portrait', 12)}<span>${escapeHtml(t('search.aspectPortrait'))}</span></button>
          <button type="button" class="omni-pill ${(state.aspectFilter || 'all') === 'square' ? 'is-active' : ''}" data-action="set-aspect" data-aspect="square">${icon('square', 12)}<span>${escapeHtml(t('search.aspectSquare'))}</span></button>
        </div>
      </div>

      <!-- Sort Order Pills -->
      <div class="sidebar-section filter-glass-card">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.sortSection'))}</span>
          <button
            type="button"
            class="sort-dir-pill"
            data-action="toggle-sort-dir"
            title="${escapeAttr(sortAsc ? t('sidebar.sortAsc') : t('sidebar.sortDesc'))}"
          >
            ${icon(sortAsc ? 'arrowUp' : 'arrowDown', 12)}
            <span>${escapeHtml(sortAsc ? t('sidebar.sortAsc') : t('sidebar.sortDesc'))}</span>
          </button>
        </div>
        <div class="sort-pill-grid" role="group" aria-label="${escapeAttr(t('gallery.sortTitle'))}">
          <button type="button" class="sort-pill ${sortField === 'date' ? 'active' : ''}" data-action="set-sort-field" data-field="date">${escapeHtml(t('sidebar.sortDate'))}</button>
          <button type="button" class="sort-pill ${sortField === 'rating' ? 'active' : ''}" data-action="set-sort-field" data-field="rating">${escapeHtml(t('sidebar.sortRating'))}</button>
          <button type="button" class="sort-pill ${sortField === 'name' ? 'active' : ''}" data-action="set-sort-field" data-field="name">${escapeHtml(t('sidebar.sortName'))}</button>
          <button type="button" class="sort-pill ${sortField === 'size' ? 'active' : ''}" data-action="set-sort-field" data-field="size">${escapeHtml(t('sidebar.sortSize'))}</button>
        </div>
      </div>

      <!-- Rating Filter -->
      <div class="sidebar-section filter-glass-card">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.ratingFilter'))}</span>
          ${
            state.minRating > 0
              ? `<button type="button" class="filter-reset-pill" data-action="set-min-rating" data-rating="0">${escapeHtml(t('sidebar.reset'))}</button>`
              : ''
          }
        </div>
        <div class="segmented segmented-sliding" style="--seg-index:${scopeIndex}" role="group">
          <button type="button" class="seg-btn ${state.ratingScope === 'avg' ? 'active' : ''}" data-action="set-rating-scope" data-scope="avg">${escapeHtml(t('sidebar.scopeAvg'))}</button>
          <button type="button" class="seg-btn ${state.ratingScope === 'mine' ? 'active' : ''}" data-action="set-rating-scope" data-scope="mine">${escapeHtml(t('sidebar.scopeMine'))}</button>
          <button type="button" class="seg-btn ${state.ratingScope === 'member' ? 'active' : ''}" data-action="set-rating-scope" data-scope="member">${escapeHtml(t('sidebar.scopeMember'))}</button>
        </div>
        <div class="star-filter-row">
          ${[0, 1, 2, 3, 4, 5]
            .map(
              (r) => `
            <button
              type="button"
              class="star-pill ${state.minRating === r ? 'active' : ''}"
              data-action="set-min-rating"
              data-rating="${r}"
              title="${escapeAttr(r === 0 ? t('sidebar.allStarsTitle') : t('sidebar.minStarsTitle', { n: r }))}"
            >${r === 0 ? escapeHtml(t('sidebar.allStars')) : `${starSectorIcon(r, 12)}<span>${r}</span>`}</button>
          `
            )
            .join('')}
        </div>
      </div>

      <!-- Folder Tree -->
      <div class="sidebar-section filter-glass-card">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.folders'))}</span>
        </div>
        <label class="sidebar-control subfolder-toggle">
          ${icon('folderOpen', 15)}
          <span class="subfolder-label">${escapeHtml(t('sidebar.includeSubfolders'))}</span>
          <input type="checkbox" role="switch" class="sr-only" id="toggleSubfoldersCheck" ${state.includeSubfolders ? 'checked' : ''} />
          <span class="subfolder-switch" aria-hidden="true"></span>
        </label>
        <div class="folder-tree">
          ${renderFolderTree(store, state)}
        </div>
      </div>

      <!-- Collaborators Filter -->
      <div class="sidebar-section filter-glass-card">
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
              <span class="nav-count member-stat-pill">${m.ratedCount}${starSectorIcon(5, 11)}</span>
            </button>
          `;
          })
          .join('')}
      </div>

      <!-- Grouped Tag Management System -->
      <div class="sidebar-section filter-glass-card">
        <div class="sidebar-section-header">
          <span>${escapeHtml(t('sidebar.tagManager'))}</span>
          <span class="sidebar-section-actions">
            <button
              type="button"
              class="filter-reset-pill"
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
      store.setIncludeSubfolders(e.target.checked);
    }
  });

  container.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'close-sidebar') {
      store.setState({ sidebarOpen: false });
      return;
    }
    if (action === 'reset-filters') {
      store.clearAllFilters();
      return;
    }
    if (action === 'select-folder') {
      store.setState({ activeFolderId: target.dataset.folderId, sidebarOpen: false });
      return;
    }
    if (action === 'quick-view') {
      store.setState({ quickView: target.dataset.view, sidebarOpen: false });
      return;
    }
    if (action === 'set-media') {
      const m = target.dataset.media;
      store.setState({ mediaFilter: store.state.mediaFilter === m ? 'all' : m });
      return;
    }
    if (action === 'set-aspect') {
      const a = target.dataset.aspect;
      store.setState({ aspectFilter: store.state.aspectFilter === a ? 'all' : a });
      return;
    }
    if (action === 'set-sort-field') {
      const nextField = target.dataset.field;
      const cur = parseSortParts(store.state.sortBy);
      if (cur.field === nextField) {
        store.setSortBy(buildSortValue(nextField, !cur.asc));
      } else {
        const defaultAsc = nextField === 'name';
        store.setSortBy(buildSortValue(nextField, defaultAsc));
      }
      return;
    }
    if (action === 'toggle-sort-dir') {
      const cur = parseSortParts(store.state.sortBy);
      store.setSortBy(buildSortValue(cur.field, !cur.asc));
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
