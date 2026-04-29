'use strict';

(function () {
    var root = document.querySelector('[data-app-slug]');
    if (!root) return;
    var slug = root.dataset.appSlug;
    var state = { app: null, activeView: 0, records: [], selected: null };

    function api(path, options) {
        return fetch('/api/a/' + encodeURIComponent(slug) + path, options).then(function (res) {
            return res.text().then(function (text) {
                var body = text ? JSON.parse(text) : null;
                if (!res.ok) throw new Error((body && body.error) || 'Request failed');
                return body;
            });
        });
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = String(text);
        return node;
    }

    function humanName(raw) {
        return String(raw || '').replace(/_/g, ' ').replace(/\b\w/g, function (m) {
            return m.toUpperCase();
        });
    }

    function entityDef(name) {
        return (state.app.blueprint.entities || []).find(function (entity) {
            return entity.name === name;
        });
    }

    function workflowFor(entityName) {
        return (state.app.blueprint.workflows || []).find(function (workflow) {
            return workflow.entity === entityName;
        });
    }

    function visibleViews() {
        var role = state.app.user.role;
        var views = state.app.blueprint.views || [];
        if (role === 'employee') {
            var employeeViews = views.filter(function (view) {
                return /request|richiest/i.test(view.entity) || /request|richiest/i.test(view.name);
            });
            return employeeViews.length ? employeeViews : views;
        }
        return views;
    }

    function currentView() {
        var views = visibleViews();
        return views[state.activeView] || views[0] || (state.app.blueprint.views || [])[0];
    }

    function selectedStatus(view) {
        var workflow = workflowFor(view.entity);
        if (!workflow || !state.selected) return null;
        return state.selected.data[workflow.state_field] || state.selected.status;
    }

    function renderApp() {
        document.getElementById('external-app-title').textContent = state.app.name;
        document.getElementById('external-app-user').textContent =
            state.app.user.display_name + ' - ' + state.app.user.role;
        loadContacts();
        renderNav();
        loadRecords();
    }

    function renderNav() {
        var nav = document.getElementById('external-app-nav');
        nav.textContent = '';
        visibleViews().forEach(function (view, index) {
            var button = el('button', 'external-tab' + (index === state.activeView ? ' active' : ''), view.name);
            button.type = 'button';
            button.addEventListener('click', function () {
                state.activeView = index;
                state.selected = null;
                renderNav();
                loadRecords();
            });
            nav.appendChild(button);
        });
    }

    function loadRecords() {
        var view = currentView();
        if (!view) {
            renderEmpty('No views configured for this app.');
            return;
        }
        api('/entities/' + encodeURIComponent(view.entity) + '/records').then(function (records) {
            state.records = records || [];
            state.selected = state.records[0] || null;
            renderTable();
            renderForm();
        }).catch(function (err) {
            renderEmpty(err.message);
        });
    }

    function renderEmpty(message) {
        var table = document.getElementById('external-app-table');
        var form = document.getElementById('external-app-form');
        table.textContent = '';
        form.textContent = '';
        table.appendChild(el('p', 'external-empty', message));
    }

    function renderTable() {
        var view = currentView();
        var entity = entityDef(view.entity);
        var tableWrap = document.getElementById('external-app-table');
        tableWrap.textContent = '';

        var title = el('div', 'external-section-title');
        title.appendChild(el('h2', null, view.name || (entity && entity.label) || humanName(view.entity)));
        title.appendChild(el('span', null, state.records.length + ' records'));
        tableWrap.appendChild(title);

        if (!state.records.length) {
            tableWrap.appendChild(el('p', 'external-empty', 'No records yet.'));
            return;
        }

        var columns = view.columns && view.columns.length ? view.columns : (entity && entity.fields || []).map(function (field) {
            return field.name;
        });
        var table = el('table', 'external-records-table');
        var thead = el('thead');
        var headRow = el('tr');
        columns.forEach(function (column) {
            headRow.appendChild(el('th', null, humanName(column)));
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        state.records.forEach(function (record) {
            var row = el('tr', state.selected && state.selected.id === record.id ? 'selected' : '');
            row.addEventListener('click', function () {
                state.selected = record;
                renderTable();
                renderForm();
            });
            columns.forEach(function (column) {
                var value = record.data[column];
                row.appendChild(el('td', null, value === undefined || value === null ? '-' : value));
            });
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        tableWrap.appendChild(table);
    }

    function renderForm() {
        var view = currentView();
        var entity = entityDef(view.entity);
        var formWrap = document.getElementById('external-app-form');
        formWrap.textContent = '';
        if (!entity) {
            formWrap.appendChild(el('p', 'external-empty', 'Entity not found.'));
            return;
        }

        var title = el('div', 'external-section-title');
        title.appendChild(el('h2', null, 'New ' + entity.label));
        formWrap.appendChild(title);

        var form = el('form', 'external-record-form');
        (entity.fields || []).forEach(function (field) {
            form.appendChild(renderField(field));
        });

        var error = el('p', 'external-error');
        var submit = el('button', 'btn btn-primary', 'Create');
        submit.type = 'submit';
        form.appendChild(submit);
        form.appendChild(error);
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            error.textContent = '';
            api('/entities/' + encodeURIComponent(view.entity) + '/records', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: formData(entity.fields || [], form) })
            }).then(function () {
                form.reset();
                loadRecords();
            }).catch(function (err) {
                error.textContent = err.message;
            });
        });
        formWrap.appendChild(form);
        renderActions(formWrap, view);
    }

    function renderField(field) {
        var label = el('label', 'external-field');
        label.appendChild(el('span', null, field.label || humanName(field.name)));
        var input;
        if (field.type === 'enum') {
            input = el('select', 'input');
            (field.options || []).forEach(function (option) {
                var item = el('option', null, option);
                item.value = option;
                input.appendChild(item);
            });
        } else if (field.type === 'text') {
            input = el('textarea', 'input');
            input.rows = 4;
        } else {
            input = el('input', 'input');
            input.type = field.type === 'number' ? 'number' :
                field.type === 'date' ? 'date' :
                    field.type === 'boolean' ? 'checkbox' : 'text';
        }
        input.name = field.name;
        input.required = !!field.required;
        if (field.default !== undefined && field.default !== null && input.type !== 'checkbox') {
            input.value = field.default;
        }
        if (input.type === 'checkbox') input.checked = !!field.default;
        label.appendChild(input);
        return label;
    }

    function formData(fields, form) {
        var data = {};
        fields.forEach(function (field) {
            var input = form.elements[field.name];
            if (!input) return;
            if (field.type === 'boolean') {
                data[field.name] = !!input.checked;
            } else if (field.type === 'number') {
                data[field.name] = input.value === '' ? null : Number(input.value);
            } else {
                data[field.name] = input.value;
            }
        });
        return data;
    }

    function renderActions(container, view) {
        var workflow = workflowFor(view.entity);
        if (!workflow || !state.selected) return;
        var status = selectedStatus(view);
        var transitions = (workflow.transitions || []).filter(function (transition) {
            return transition.from === status;
        });
        if (!transitions.length) return;

        var actions = el('div', 'external-actions');
        actions.appendChild(el('h3', null, 'Actions'));
        transitions.forEach(function (transition) {
            var button = el('button', 'btn btn-secondary btn-sm', transition.label || humanName(transition.name));
            button.type = 'button';
            button.addEventListener('click', function () {
                api('/entities/' + encodeURIComponent(view.entity) + '/records/' + state.selected.id +
                    '/actions/' + encodeURIComponent(transition.name), { method: 'POST' }).then(function () {
                    loadRecords();
                }).catch(function (err) {
                    window.alert(err.message);
                });
            });
            actions.appendChild(button);
        });
        container.appendChild(actions);
    }

    function loadContacts() {
        var dashboard = document.getElementById('external-app-dashboard');
        if (!dashboard) return;
        dashboard.textContent = '';
        api('/contacts').then(function (contacts) {
            renderContacts(contacts || []);
        }).catch(function () {
            renderContacts([]);
        });
    }

    function renderContacts(contacts) {
        var dashboard = document.getElementById('external-app-dashboard');
        if (!dashboard) return;
        dashboard.textContent = '';
        if (!contacts.length) return;
        var panel = el('section', 'external-contacts-panel');
        var title = el('div', 'external-section-title');
        title.appendChild(el('h2', null, 'Contacts'));
        title.appendChild(el('span', null, contacts.length + ' allowed'));
        panel.appendChild(title);
        var list = el('div', 'external-contact-list');
        contacts.forEach(function (contact) {
            var item = el('article', 'external-contact-card');
            item.appendChild(el('strong', null, contact.name));
            if (contact.nickname) item.appendChild(el('span', null, contact.nickname));
            if (contact.preferred_channel) item.appendChild(el('small', null, contact.preferred_channel));
            list.appendChild(item);
        });
        panel.appendChild(list);
        dashboard.appendChild(panel);
    }

    var loginForm = document.getElementById('external-login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', function (event) {
            event.preventDefault();
            var data = new FormData(loginForm);
            api('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: data.get('email'),
                    password: data.get('password')
                })
            }).then(function () {
                location.href = '/a/' + encodeURIComponent(slug);
            }).catch(function (err) {
                document.getElementById('external-login-error').textContent = err.message;
            });
        });
        return;
    }

    var logout = document.getElementById('external-logout');
    if (logout) {
        logout.addEventListener('click', function () {
            api('/logout', { method: 'POST' }).finally(function () {
                location.href = '/a/' + encodeURIComponent(slug) + '/login';
            });
        });
    }

    api('/meta').then(function (meta) {
        state.app = meta;
        renderApp();
    }).catch(function () {
        location.href = '/a/' + encodeURIComponent(slug) + '/login';
    });
}());
