'use strict';

(function () {
    var state = {
        app: null,
        activeViewIndex: 0,
        records: [],
        selectedRecord: null,
        statusFilter: 'all',
        search: '',
        relationRecords: {},
        appUsers: [],
        appVersions: []
    };

    function qs(selector, root) {
        return (root || document).querySelector(selector);
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function iconSvg(path) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        path.forEach(function (d) {
            var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            p.setAttribute('d', d);
            svg.appendChild(p);
        });
        return svg;
    }

    function api(url, options) {
        return fetch(url, options).then(function (res) {
            return res.text().then(function (text) {
                var data = text ? JSON.parse(text) : null;
                if (!res.ok) {
                    var message = data && data.error ? data.error : 'Request failed';
                    if (data && Array.isArray(data.details)) message += ': ' + data.details.join(' | ');
                    throw new Error(message);
                }
                return data;
            });
        });
    }

    function activeProfileQuery() {
        var slug = window.getActiveProfileSlug ? window.getActiveProfileSlug() : '';
        return slug ? '?profile=' + encodeURIComponent(slug) : '';
    }

    function showInline(container, message) {
        container.textContent = '';
        var empty = el('div', 'empty-state');
        empty.appendChild(el('p', '', message));
        container.appendChild(empty);
    }

    function renderAppsList(apps) {
        var list = qs('#apps-list');
        var count = qs('#apps-count');
        if (!list) return;
        list.textContent = '';
        if (count) count.textContent = String(apps.length);
        if (!apps.length) {
            showInline(list, 'No internal apps yet.');
            return;
        }
        apps.forEach(function (app) {
            var card = el('a', 'app-list-card');
            card.href = '/apps/' + encodeURIComponent(app.slug);

            var top = el('div', 'app-list-card-top');
            var glyph = el('span', 'app-list-icon');
            glyph.appendChild(iconSvg(['M3 3h4v4H3z', 'M9 3h4v4H9z', 'M3 9h4v4H3z', 'M9 9h4v4H9z']));
            top.appendChild(glyph);
            top.appendChild(el('span', 'app-list-status', app.status || 'active'));
            card.appendChild(top);

            card.appendChild(el('h2', 'app-list-title', app.name || app.slug));
            card.appendChild(el('p', 'app-list-desc', app.description || 'Internal app generated from blueprint.'));

            var meta = el('div', 'app-list-meta');
            meta.appendChild(el('span', '', app.storage_mode || 'sqlite_per_app'));
            meta.appendChild(el('span', '', (app.blueprint && app.blueprint.entities ? app.blueprint.entities.length : 0) + ' entities'));
            card.appendChild(meta);
            list.appendChild(card);
        });
    }

    function loadAppsList() {
        var list = qs('#apps-list');
        if (list) showInline(list, 'Loading apps...');
        return api('/api/v1/apps' + activeProfileQuery())
            .then(renderAppsList)
            .catch(function (err) {
                if (list) showInline(list, err.message);
            });
    }

    function currentView() {
        var views = runtimeViews();
        if (!views.length) return null;
        return views[state.activeViewIndex] || views[0];
    }

    function runtimeViews() {
        if (!state.app || !state.app.blueprint) return [];
        var blueprint = state.app.blueprint;
        var views = (blueprint.views || []).slice();
        var covered = {};
        views.forEach(function (view) {
            if (view && view.entity) covered[view.entity] = true;
        });
        (blueprint.entities || []).forEach(function (entity) {
            if (covered[entity.name]) return;
            views.push({
                type: 'table',
                entity: entity.name,
                name: entity.label || entity.name,
                columns: (entity.fields || []).slice(0, 5).map(function (field) { return field.name; })
            });
        });
        return views;
    }

    function entityDef(name) {
        var entities = state.app && state.app.blueprint ? state.app.blueprint.entities || [] : [];
        return entities.find(function (entity) { return entity.name === name; }) || null;
    }

    function workflowFor(entityName) {
        var workflows = state.app && state.app.blueprint ? state.app.blueprint.workflows || [] : [];
        return workflows.find(function (workflow) { return workflow.entity === entityName; }) || null;
    }

    function fieldLabel(entity, fieldName) {
        var field = entity && entity.fields ? entity.fields.find(function (f) { return f.name === fieldName; }) : null;
        return field ? field.label : fieldName;
    }

    function valueText(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }

    function humanName(raw) {
        return String(raw || '')
            .replace(/_/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, function (m) { return m.toUpperCase(); });
    }

    function viewTitle(view) {
        if (!view) return '';
        return humanName(view.name || view.entity);
    }

    function viewColumns(view, entity) {
        if (view && view.columns && view.columns.length) return view.columns;
        return entity && entity.fields ? entity.fields.slice(0, 6).map(function (field) { return field.name; }) : [];
    }

    function recordLabel(entityName, record) {
        var entity = entityDef(entityName);
        var data = record && record.data ? record.data : {};
        var preferred = ['full_name', 'name', 'title', 'email', 'nome'];
        for (var i = 0; i < preferred.length; i++) {
            if (data[preferred[i]]) return valueText(data[preferred[i]]);
        }
        if (data.nome && data.cognome) return data.nome + ' ' + data.cognome;
        var firstField = entity && entity.fields && entity.fields[0] ? entity.fields[0].name : null;
        return firstField && data[firstField] ? valueText(data[firstField]) : '#' + record.id;
    }

    function fieldDef(entity, fieldName) {
        return entity && entity.fields ? entity.fields.find(function (field) { return field.name === fieldName; }) : null;
    }

    function fieldValueText(entity, fieldName, value) {
        var field = fieldDef(entity, fieldName);
        if (field && field.type === 'relation' && field.to) {
            var related = state.relationRecords[field.to] || [];
            var match = related.find(function (record) { return String(record.id) === String(value); });
            if (match) return recordLabel(field.to, match);
        }
        if (field && field.type === 'boolean') return value ? 'Yes' : 'No';
        return valueText(value);
    }

    function filteredRecords() {
        var search = state.search.trim().toLowerCase();
        return state.records.filter(function (record) {
            if (state.statusFilter !== 'all' && String(record.status || '') !== state.statusFilter) return false;
            if (!search) return true;
            return JSON.stringify(record.data || {}).toLowerCase().indexOf(search) !== -1;
        });
    }

    function relationTargets(entity) {
        var seen = {};
        return (entity && entity.fields ? entity.fields : []).filter(function (field) {
            if (field.type !== 'relation' || !field.to || seen[field.to]) return false;
            seen[field.to] = true;
            return true;
        }).map(function (field) { return field.to; });
    }

    function setSelectedRecord(record) {
        state.selectedRecord = record;
        renderDetail();
    }

    function renderRuntime() {
        var root = qs('#app-runtime');
        if (!root || !state.app) return;
        root.textContent = '';

        var header = el('div', 'app-runtime-header');
        var titleGroup = el('div', 'page-title-group');
        titleGroup.appendChild(el('h1', 'page-title', state.app.name || state.app.slug));
        titleGroup.appendChild(el('p', 'page-subtitle', state.app.description || 'Internal app generated from blueprint.'));
        header.appendChild(titleGroup);
        var actions = el('div', 'actions');
        actions.appendChild(el('span', 'app-status-pill', state.app.status || 'active'));
        var back = el('a', 'btn btn-secondary btn-sm', 'Apps');
        back.href = '/apps';
        actions.appendChild(back);
        var refresh = el('button', 'btn btn-secondary btn-sm', 'Refresh');
        refresh.addEventListener('click', loadActiveRecords);
        actions.appendChild(refresh);
        header.appendChild(actions);
        root.appendChild(header);

        root.appendChild(renderSummary());
        root.appendChild(renderStudioPanel());
        root.appendChild(renderBlueprintPanel());

        var tabs = el('div', 'app-runtime-tabs');
        runtimeViews().forEach(function (view, index) {
            var tab = el('button', 'app-runtime-tab' + (index === state.activeViewIndex ? ' active' : ''), viewTitle(view));
            tab.type = 'button';
            tab.addEventListener('click', function () {
                state.activeViewIndex = index;
                state.selectedRecord = null;
                state.statusFilter = 'all';
                state.search = '';
                renderRuntime();
                loadActiveRecords();
            });
            tabs.appendChild(tab);
        });
        root.appendChild(tabs);

        var layout = el('div', 'app-runtime-layout');
        var main = el('section', 'app-runtime-main');
        main.appendChild(el('div', 'app-runtime-table-wrap'));
        layout.appendChild(main);

        var side = el('aside', 'app-runtime-form');
        side.appendChild(el('h2', 'app-form-title'));
        side.appendChild(el('form', 'app-record-form'));
        side.appendChild(el('div', 'app-record-detail'));
        layout.appendChild(side);
        root.appendChild(layout);

        renderForm();
        renderTable();
        renderDetail();
    }

    function renderStudioPanel() {
        var panel = el('section', 'app-studio-panel');
        var header = el('div', 'app-studio-panel-header');
        var title = el('div');
        title.appendChild(el('h2', '', 'External access'));
        title.appendChild(el('p', '', 'Manage the standalone app link and app-local users.'));
        header.appendChild(title);
        var linkActions = el('div', 'actions');
        var publicUrl = '/a/' + encodeURIComponent(state.app.slug);
        var open = el('a', 'btn btn-secondary btn-sm', 'Open app');
        open.href = publicUrl;
        open.target = '_blank';
        open.rel = 'noopener';
        linkActions.appendChild(open);
        var copy = el('button', 'btn btn-secondary btn-sm', 'Copy link');
        copy.type = 'button';
        copy.addEventListener('click', function () {
            navigator.clipboard.writeText(location.origin + publicUrl).then(function () {
                if (window.showToast) window.showToast('App link copied', 'success');
            }).catch(function () {
                if (window.showToast) window.showToast('Unable to copy link', 'error');
            });
        });
        linkActions.appendChild(copy);
        header.appendChild(linkActions);
        panel.appendChild(header);

        var body = el('div', 'app-studio-users-layout');
        body.appendChild(renderAppUsersList());
        body.appendChild(renderAppUserForm());
        panel.appendChild(body);
        return panel;
    }

    function renderAppUsersList() {
        var wrap = el('div', 'app-studio-users');
        wrap.appendChild(el('h3', '', 'App users'));
        if (!state.appUsers.length) {
            wrap.appendChild(el('p', 'muted', 'No app users yet.'));
            return wrap;
        }
        state.appUsers.forEach(function (user) {
            var row = el('div', 'app-studio-user-row');
            var identity = el('div');
            identity.appendChild(el('strong', '', user.display_name || user.email));
            identity.appendChild(el('span', '', user.email));
            row.appendChild(identity);
            row.appendChild(el('span', 'app-status-pill', user.role));
            wrap.appendChild(row);
        });
        return wrap;
    }

    function renderAppUserForm() {
        var form = el('form', 'app-studio-user-form');
        form.appendChild(el('h3', '', 'Create user'));
        [
            ['email', 'Email', 'email'],
            ['display_name', 'Display name', 'text'],
            ['password', 'Password', 'password']
        ].forEach(function (field) {
            var label = el('label', 'app-field');
            label.appendChild(el('span', '', field[1]));
            var input = document.createElement('input');
            input.className = 'input';
            input.name = field[0];
            input.type = field[2];
            input.required = true;
            if (field[0] === 'password') input.minLength = 8;
            label.appendChild(input);
            form.appendChild(label);
        });
        var roleLabel = el('label', 'app-field');
        roleLabel.appendChild(el('span', '', 'Role'));
        var role = document.createElement('select');
        role.className = 'input';
        role.name = 'role';
        ['admin', 'approver', 'employee', 'viewer'].forEach(function (item) {
            var option = document.createElement('option');
            option.value = item;
            option.textContent = humanName(item);
            role.appendChild(option);
        });
        roleLabel.appendChild(role);
        form.appendChild(roleLabel);

        var error = el('p', 'external-error');
        var submit = el('button', 'btn btn-primary', 'Create user');
        submit.type = 'submit';
        form.appendChild(submit);
        form.appendChild(error);
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            error.textContent = '';
            var data = new FormData(form);
            api('/api/v1/apps/' + encodeURIComponent(state.app.slug) + '/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: data.get('email'),
                    display_name: data.get('display_name'),
                    password: data.get('password'),
                    role: data.get('role')
                })
            }).then(function () {
                form.reset();
                if (window.showToast) window.showToast('App user created', 'success');
                return loadAppUsers();
            }).catch(function (err) {
                error.textContent = err.message;
            });
        });
        return form;
    }

    function renderBlueprintPanel() {
        var panel = el('section', 'app-blueprint-panel');
        var header = el('div', 'app-studio-panel-header');
        var title = el('div');
        title.appendChild(el('h2', '', 'Blueprint'));
        title.appendChild(el('p', '', 'Edit the declarative app definition. The slug is locked in this version.'));
        header.appendChild(title);
        header.appendChild(el('span', 'app-status-pill', 'v' + state.app.schema_version));
        panel.appendChild(header);

        var layout = el('div', 'app-blueprint-layout');
        var editorWrap = el('form', 'app-blueprint-editor');
        var textarea = document.createElement('textarea');
        textarea.className = 'input app-blueprint-textarea';
        textarea.name = 'blueprint';
        textarea.spellcheck = false;
        textarea.value = JSON.stringify(state.app.blueprint || {}, null, 2);
        editorWrap.appendChild(textarea);

        var note = document.createElement('input');
        note.className = 'input';
        note.name = 'change_note';
        note.placeholder = 'Change note';
        editorWrap.appendChild(note);

        var error = el('p', 'external-error');
        var actions = el('div', 'actions');
        var validate = el('button', 'btn btn-secondary btn-sm', 'Validate');
        validate.type = 'button';
        validate.addEventListener('click', function () {
            try {
                JSON.parse(textarea.value);
                error.textContent = 'JSON syntax is valid. Server validation runs on save.';
            } catch (err) {
                error.textContent = err.message;
            }
        });
        actions.appendChild(validate);
        var save = el('button', 'btn btn-primary btn-sm', 'Save version');
        save.type = 'submit';
        actions.appendChild(save);
        editorWrap.appendChild(actions);
        editorWrap.appendChild(error);
        editorWrap.addEventListener('submit', function (event) {
            event.preventDefault();
            error.textContent = '';
            var blueprint;
            try {
                blueprint = JSON.parse(textarea.value);
            } catch (err) {
                error.textContent = err.message;
                return;
            }
            api('/api/v1/apps/' + encodeURIComponent(state.app.slug) + '/blueprint', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    blueprint: blueprint,
                    change_note: note.value || 'Blueprint updated from Studio'
                })
            }).then(function (updated) {
                state.app.blueprint = updated.blueprint;
                state.app.schema_version = updated.schema_version;
                textarea.value = JSON.stringify(updated.blueprint, null, 2);
                note.value = '';
                if (window.showToast) window.showToast('Blueprint saved', 'success');
                return loadAppVersions();
            }).then(function () {
                renderRuntime();
                return loadActiveRecords();
            }).catch(function (err) {
                error.textContent = err.message;
            });
        });
        layout.appendChild(editorWrap);
        layout.appendChild(renderVersionsList());
        panel.appendChild(layout);
        return panel;
    }

    function renderVersionsList() {
        var wrap = el('div', 'app-blueprint-versions');
        wrap.appendChild(el('h3', '', 'Versions'));
        if (!state.appVersions.length) {
            wrap.appendChild(el('p', 'muted', 'No versions loaded yet.'));
            return wrap;
        }
        state.appVersions.forEach(function (version) {
            var row = el('button', 'app-blueprint-version');
            row.type = 'button';
            row.appendChild(el('strong', '', 'v' + version.version_number));
            row.appendChild(el('span', '', version.change_note || 'Blueprint version'));
            row.appendChild(el('small', '', version.created_at || ''));
            row.addEventListener('click', function () {
                var textarea = qs('.app-blueprint-textarea');
                if (textarea) textarea.value = JSON.stringify(version.blueprint || {}, null, 2);
            });
            wrap.appendChild(row);
        });
        return wrap;
    }

    function renderSummary() {
        var view = currentView();
        var entity = view ? entityDef(view.entity) : null;
        var workflow = entity ? workflowFor(entity.name) : null;
        var summary = el('div', 'app-runtime-summary');
        var total = el('div', 'app-summary-card');
        total.appendChild(el('span', '', 'Records'));
        total.appendChild(el('strong', '', state.records.length));
        summary.appendChild(total);

        if (workflow && workflow.states && workflow.states.length) {
            workflow.states.forEach(function (status) {
                var card = el('button', 'app-summary-card app-summary-card-button' + (state.statusFilter === status ? ' active' : ''));
                card.type = 'button';
                card.appendChild(el('span', '', humanName(status)));
                card.appendChild(el('strong', '', state.records.filter(function (record) { return record.status === status; }).length));
                card.addEventListener('click', function () {
                    state.statusFilter = state.statusFilter === status ? 'all' : status;
                    renderRuntime();
                });
                summary.appendChild(card);
            });
        }
        return summary;
    }

    function renderForm() {
        var form = qs('.app-record-form');
        var view = currentView();
        var entity = view ? entityDef(view.entity) : null;
        if (!form || !entity) return;
        form.textContent = '';
        var title = qs('.app-form-title');
        if (title) title.textContent = 'New ' + (entity.label || humanName(entity.name));

        entity.fields.forEach(function (field) {
            if (field.name === (workflowFor(entity.name) || {}).state_field) return;
            var group = el('label', 'app-field');
            group.appendChild(el('span', '', field.label || field.name));
            var input;
            if (field.type === 'relation' && field.to && state.relationRecords[field.to]) {
                input = document.createElement('select');
                var blank = document.createElement('option');
                blank.value = '';
                blank.textContent = 'Select ' + humanName(field.to);
                input.appendChild(blank);
                state.relationRecords[field.to].forEach(function (record) {
                    var opt = document.createElement('option');
                    opt.value = record.id;
                    opt.textContent = recordLabel(field.to, record);
                    input.appendChild(opt);
                });
            } else if (field.type === 'enum') {
                input = document.createElement('select');
                (field.options || []).forEach(function (option) {
                    var opt = document.createElement('option');
                    opt.value = option;
                    opt.textContent = option;
                    input.appendChild(opt);
                });
            } else if (field.type === 'boolean') {
                input = document.createElement('input');
                input.type = 'checkbox';
            } else if (field.type === 'number') {
                input = document.createElement('input');
                input.type = 'number';
                input.step = 'any';
            } else if (field.type === 'date') {
                input = document.createElement('input');
                input.type = 'date';
            } else if (field.type === 'text') {
                input = document.createElement('textarea');
                input.rows = 3;
            } else {
                input = document.createElement('input');
                input.type = 'text';
            }
            input.className = 'input';
            input.name = field.name;
            input.required = !!field.required;
            if (field.type === 'relation' && field.to) input.placeholder = 'Select or enter ' + humanName(field.to);
            group.appendChild(input);
            form.appendChild(group);
        });

        var submit = el('button', 'btn btn-primary app-submit-btn', 'Create ' + (entity.label || humanName(entity.name)));
        submit.type = 'submit';
        form.appendChild(submit);
        form.addEventListener('submit', submitRecord, { once: true });
    }

    function formData(entity) {
        var form = qs('.app-record-form');
        var data = {};
        entity.fields.forEach(function (field) {
            var input = form.elements[field.name];
            if (!input) return;
            if (field.type === 'boolean') data[field.name] = !!input.checked;
            else if (field.type === 'number') {
                if (input.value !== '') data[field.name] = Number(input.value);
            } else if (input.value !== '') data[field.name] = input.value;
        });
        return data;
    }

    function submitRecord(event) {
        event.preventDefault();
        var view = currentView();
        var entity = view ? entityDef(view.entity) : null;
        if (!view || !entity) return;
        api('/api/v1/apps/' + encodeURIComponent(state.app.slug) + '/entities/' + encodeURIComponent(entity.name) + '/records', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: formData(entity) })
        }).then(function () {
            if (window.showToast) window.showToast('Record created', 'success');
            renderForm();
            return loadActiveRecords();
        }).catch(function (err) {
            if (window.showToast) window.showToast(err.message, 'error', 4000);
            renderForm();
        });
    }

    function renderTable() {
        var wrap = qs('.app-runtime-table-wrap');
        var view = currentView();
        var entity = view ? entityDef(view.entity) : null;
        if (!wrap || !view || !entity) return;
        wrap.textContent = '';

        var controls = el('div', 'app-runtime-controls');
        var search = document.createElement('input');
        search.className = 'input app-runtime-search';
        search.type = 'search';
        search.placeholder = 'Search ' + viewTitle(view).toLowerCase();
        search.value = state.search;
        search.addEventListener('input', function () {
            state.search = search.value;
            renderTable();
        });
        controls.appendChild(search);

        var workflow = workflowFor(entity.name);
        if (workflow && workflow.states && workflow.states.length) {
            var filter = document.createElement('select');
            filter.className = 'input app-runtime-filter';
            [['all', 'All states']].concat(workflow.states.map(function (status) {
                return [status, humanName(status)];
            })).forEach(function (item) {
                var opt = document.createElement('option');
                opt.value = item[0];
                opt.textContent = item[1];
                filter.appendChild(opt);
            });
            filter.value = state.statusFilter;
            filter.addEventListener('change', function () {
                state.statusFilter = filter.value;
                renderRuntime();
            });
            controls.appendChild(filter);
        }
        wrap.appendChild(controls);

        var records = filteredRecords();
        if (!records.length) {
            var empty = el('div', 'empty-state');
            empty.appendChild(el('p', '', state.records.length ? 'No records match the current filter.' : 'No ' + viewTitle(view).toLowerCase() + ' yet.'));
            wrap.appendChild(empty);
            return;
        }

        var table = el('table', 'app-runtime-table');
        var thead = document.createElement('thead');
        var headRow = document.createElement('tr');
        viewColumns(view, entity).forEach(function (column) {
            headRow.appendChild(el('th', '', fieldLabel(entity, column)));
        });
        headRow.appendChild(el('th', '', 'Status'));
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        records.forEach(function (record) {
            var row = document.createElement('tr');
            row.tabIndex = 0;
            row.addEventListener('click', function () { setSelectedRecord(record); });
            viewColumns(view, entity).forEach(function (column) {
                row.appendChild(el('td', '', fieldValueText(entity, column, record.data[column])));
            });
            var status = el('td');
            status.appendChild(el('span', 'app-status-pill', record.status || ''));
            row.appendChild(status);
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
    }

    function renderDetail() {
        var detail = qs('.app-record-detail');
        var view = currentView();
        var entity = view ? entityDef(view.entity) : null;
        if (!detail || !entity) return;
        detail.textContent = '';
        if (!state.selectedRecord) return;

        detail.appendChild(el('h2', '', 'Selected ' + (entity.label || humanName(entity.name))));
        entity.fields.forEach(function (field) {
            var row = el('div', 'app-detail-row');
            row.appendChild(el('span', '', field.label || field.name));
            row.appendChild(el('strong', '', fieldValueText(entity, field.name, state.selectedRecord.data[field.name])));
            detail.appendChild(row);
        });

        var workflow = workflowFor(entity.name);
        if (!workflow || !workflow.transitions.length) return;
        var actions = el('div', 'app-runtime-actions');
        workflow.transitions.forEach(function (transition) {
            if (transition.from !== state.selectedRecord.status) return;
            var button = el('button', 'btn btn-primary btn-sm', transition.label || transition.name);
            button.type = 'button';
            button.addEventListener('click', function () { runAction(entity.name, state.selectedRecord.id, transition.name); });
            actions.appendChild(button);
        });
        if (actions.childNodes.length) detail.appendChild(actions);
    }

    function runAction(entityName, recordId, action) {
        api('/api/v1/apps/' + encodeURIComponent(state.app.slug) + '/entities/' + encodeURIComponent(entityName) + '/records/' + encodeURIComponent(recordId) + '/actions/' + encodeURIComponent(action), {
            method: 'POST'
        }).then(function () {
            if (window.showToast) window.showToast('Action completed', 'success');
            state.selectedRecord = null;
            return loadActiveRecords();
        }).catch(function (err) {
            if (window.showToast) window.showToast(err.message, 'error', 4000);
        });
    }

    function loadActiveRecords() {
        var view = currentView();
        if (!view) return Promise.resolve();
        var entity = entityDef(view.entity);
        var wrap = qs('.app-runtime-table-wrap');
        if (wrap) showInline(wrap, 'Loading records...');
        return api('/api/v1/apps/' + encodeURIComponent(state.app.slug) + '/entities/' + encodeURIComponent(view.entity) + '/records')
            .then(function (records) {
                state.records = records || [];
                return loadRelationRecords(entity);
            })
            .then(function () {
                renderRuntime();
            })
            .catch(function (err) {
                if (wrap) showInline(wrap, err.message);
            });
    }

    function loadRelationRecords(entity) {
        var targets = relationTargets(entity).filter(function (target) {
            return !state.relationRecords[target];
        });
        if (!targets.length) return Promise.resolve();
        return Promise.all(targets.map(function (target) {
            return api('/api/v1/apps/' + encodeURIComponent(state.app.slug) + '/entities/' + encodeURIComponent(target) + '/records')
                .then(function (records) {
                    state.relationRecords[target] = records || [];
                })
                .catch(function () {
                    state.relationRecords[target] = [];
                });
        }));
    }

    function loadAppDetail(slug) {
        return api('/api/v1/apps/' + encodeURIComponent(slug))
            .then(function (app) {
                state.app = app;
                state.activeViewIndex = 0;
                state.relationRecords = {};
                state.appUsers = [];
                state.appVersions = [];
                renderRuntime();
                return Promise.all([loadActiveRecords(), loadAppUsers(), loadAppVersions()]);
            })
            .catch(function (err) {
                var root = qs('#app-runtime');
                if (root) showInline(root, err.message);
            });
    }

    function loadAppUsers() {
        if (!state.app) return Promise.resolve();
        return api('/api/v1/apps/' + encodeURIComponent(state.app.slug) + '/users')
            .then(function (users) {
                state.appUsers = users || [];
                renderRuntime();
            })
            .catch(function (err) {
                if (window.showToast) window.showToast(err.message, 'error', 4000);
            });
    }

    function loadAppVersions() {
        if (!state.app) return Promise.resolve();
        return api('/api/v1/apps/' + encodeURIComponent(state.app.slug) + '/versions')
            .then(function (versions) {
                state.appVersions = versions || [];
                renderRuntime();
            })
            .catch(function (err) {
                if (window.showToast) window.showToast(err.message, 'error', 4000);
            });
    }

    function init() {
        var list = qs('#apps-list');
        var runtime = qs('#app-runtime');
        var refresh = qs('#btn-apps-refresh');
        if (refresh) refresh.addEventListener('click', loadAppsList);
        document.addEventListener('profile-changed', function () {
            if (list) loadAppsList();
        });
        if (list) loadAppsList();
        if (runtime) loadAppDetail(runtime.dataset.appSlug || '');
    }

    document.addEventListener('DOMContentLoaded', init);
})();
