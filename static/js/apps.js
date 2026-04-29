'use strict';

(function () {
    var state = {
        app: null,
        activeViewIndex: 0,
        records: [],
        selectedRecord: null
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
        if (!state.app || !state.app.blueprint || !state.app.blueprint.views.length) return null;
        return state.app.blueprint.views[state.activeViewIndex] || state.app.blueprint.views[0];
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
        var back = el('a', 'btn btn-secondary btn-sm', 'Apps');
        back.href = '/apps';
        actions.appendChild(back);
        var refresh = el('button', 'btn btn-secondary btn-sm', 'Refresh');
        refresh.addEventListener('click', loadActiveRecords);
        actions.appendChild(refresh);
        header.appendChild(actions);
        root.appendChild(header);

        var tabs = el('div', 'app-runtime-tabs');
        (state.app.blueprint.views || []).forEach(function (view, index) {
            var tab = el('button', 'app-runtime-tab' + (index === state.activeViewIndex ? ' active' : ''), view.name);
            tab.type = 'button';
            tab.addEventListener('click', function () {
                state.activeViewIndex = index;
                state.selectedRecord = null;
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
        side.appendChild(el('h2', '', 'New Record'));
        side.appendChild(el('form', 'app-record-form'));
        side.appendChild(el('div', 'app-record-detail'));
        layout.appendChild(side);
        root.appendChild(layout);

        renderForm();
        renderTable();
        renderDetail();
    }

    function renderForm() {
        var form = qs('.app-record-form');
        var view = currentView();
        var entity = view ? entityDef(view.entity) : null;
        if (!form || !entity) return;
        form.textContent = '';

        entity.fields.forEach(function (field) {
            if (field.name === (workflowFor(entity.name) || {}).state_field) return;
            var group = el('label', 'app-field');
            group.appendChild(el('span', '', field.label || field.name));
            var input;
            if (field.type === 'enum') {
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
            group.appendChild(input);
            form.appendChild(group);
        });

        var submit = el('button', 'btn btn-primary app-submit-btn', 'Create');
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

        if (!state.records.length) {
            showInline(wrap, 'No records yet.');
            return;
        }

        var table = el('table', 'app-runtime-table');
        var thead = document.createElement('thead');
        var headRow = document.createElement('tr');
        (view.columns || []).forEach(function (column) {
            headRow.appendChild(el('th', '', fieldLabel(entity, column)));
        });
        headRow.appendChild(el('th', '', 'Status'));
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        state.records.forEach(function (record) {
            var row = document.createElement('tr');
            row.tabIndex = 0;
            row.addEventListener('click', function () { setSelectedRecord(record); });
            (view.columns || []).forEach(function (column) {
                row.appendChild(el('td', '', valueText(record.data[column])));
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

        detail.appendChild(el('h2', '', 'Selected Record'));
        entity.fields.forEach(function (field) {
            var row = el('div', 'app-detail-row');
            row.appendChild(el('span', '', field.label || field.name));
            row.appendChild(el('strong', '', valueText(state.selectedRecord.data[field.name])));
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
        var wrap = qs('.app-runtime-table-wrap');
        if (wrap) showInline(wrap, 'Loading records...');
        return api('/api/v1/apps/' + encodeURIComponent(state.app.slug) + '/entities/' + encodeURIComponent(view.entity) + '/records')
            .then(function (records) {
                state.records = records || [];
                renderTable();
                renderDetail();
            })
            .catch(function (err) {
                if (wrap) showInline(wrap, err.message);
            });
    }

    function loadAppDetail(slug) {
        return api('/api/v1/apps/' + encodeURIComponent(slug))
            .then(function (app) {
                state.app = app;
                state.activeViewIndex = 0;
                renderRuntime();
                return loadActiveRecords();
            })
            .catch(function (err) {
                var root = qs('#app-runtime');
                if (root) showInline(root, err.message);
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
