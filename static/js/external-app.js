'use strict';

(function () {
    var root = document.querySelector('[data-app-slug]');
    if (!root) return;
    var slug = root.dataset.appSlug;
    var state = {
        app: null,
        activeView: 0,
        records: [],
        selected: null,
        contacts: [],
        relatedRecords: {},
        calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        statusFilter: 'all',
        search: '',
        editMode: false
    };

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
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function humanName(raw) {
        return String(raw || '')
            .replace(/_/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, function (m) { return m.toUpperCase(); });
    }

    function valueText(value) {
        if (value === null || value === undefined || value === '') return '-';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
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

    function fieldDef(entity, fieldName) {
        return entity && entity.fields ? entity.fields.find(function (field) {
            return field.name === fieldName;
        }) : null;
    }

    function role() {
        return state.app && state.app.user ? state.app.user.role : '';
    }

    function roleAllowed(roles) {
        return role() === 'admin' || !roles || !roles.length || roles.indexOf(role()) !== -1;
    }

    function viewRef(view) {
        return view.id || view.name;
    }

    function navLabel(view) {
        var navigation = state.app.blueprint.navigation || [];
        var item = navigation.find(function (entry) {
            return entry.view === viewRef(view) || entry.view === view.name;
        });
        return (item && item.label) || view.name || humanName(view.entity);
    }

    function iconClass(view) {
        var label = (navLabel(view) + ' ' + view.entity).toLowerCase();
        if (view.type === 'kanban') return 'icon-workflow';
        if (view.type === 'calendar') return 'icon-calendar';
        if (/new|nuov|create|form/.test(label)) return 'icon-add';
        if (/request|richiest|ticket|workflow/.test(label)) return 'icon-workflow';
        if (/dashboard|stat|approv/.test(label)) return 'icon-settings';
        if (/employee|dipendent|contact|person/.test(label)) return 'icon-person';
        return 'icon-list';
    }

    function fieldWritable(field) {
        if (role() === 'admin' && field.managed_by !== 'workflow') return true;
        if (field.system || field.managed_by) {
            return (field.editable_by || []).indexOf(role()) !== -1;
        }
        return !(field.editable_by || []).length || field.editable_by.indexOf(role()) !== -1;
    }

    function formFields(entity, workflow) {
        return (entity.fields || []).filter(function (field) {
            if (workflow && field.name === workflow.state_field) return false;
            if (field.system || field.managed_by) return false;
            return fieldWritable(field);
        });
    }

    function visibleViews() {
        var views = state.app.blueprint.views || [];
        var navigation = state.app.blueprint.navigation || [];
        if (navigation.length) {
            return navigation
                .filter(function (item) { return roleAllowed(item.roles); })
                .map(function (item) {
                    return views.find(function (view) {
                        return viewRef(view) === item.view || view.name === item.view;
                    });
                })
                .filter(Boolean);
        }
        return views.filter(function (view) { return roleAllowed(view.roles); });
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

    function relationLabel(entityName, value) {
        var records = state.relatedRecords[entityName] || [];
        var match = records.find(function (record) {
            return String(record.id) === String(value);
        });
        return match ? primaryRecordTitle(entityDef(entityName), match) : valueText(value);
    }

    function fieldDisplayValue(entity, fieldName, value) {
        var field = fieldDef(entity, fieldName);
        if (field && field.type === 'relation' && field.to) return relationLabel(field.to, value);
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

    function renderApp() {
        root.textContent = '';
        root.className = 'external-app-shell work-os';
        root.appendChild(renderHero());
        root.appendChild(renderWorkbench());
        loadContacts();
        renderNav();
        loadRecords();
    }

    function renderHero() {
        var hero = el('header', 'external-topbar');
        var identity = el('div', 'external-brand');
        identity.appendChild(el('div', 'external-app-mark', (state.app.name || 'A').charAt(0)));
        var copy = el('div');
        copy.appendChild(el('div', 'external-kicker', 'Live app'));
        copy.appendChild(el('h1', null, state.app.name));
        copy.appendChild(el('p', null, state.app.description || 'Operational workspace.'));
        identity.appendChild(copy);
        hero.appendChild(identity);

        var account = el('div', 'external-account');
        var user = el('div', 'external-user-chip');
        user.appendChild(el('strong', null, state.app.user.display_name));
        user.appendChild(el('span', null, humanName(state.app.user.role)));
        account.appendChild(user);
        var logout = el('button', 'external-icon-button', 'Sign out');
        logout.type = 'button';
        logout.addEventListener('click', function () {
            api('/logout', { method: 'POST' }).finally(function () {
                location.href = '/a/' + encodeURIComponent(slug) + '/login';
            });
        });
        account.appendChild(logout);
        hero.appendChild(account);
        return hero;
    }

    function renderMetrics() {
        var wrap = el('section', 'external-metrics');
        wrap.id = 'external-app-dashboard';
        var view = currentView();
        var workflow = view ? workflowFor(view.entity) : null;
        if (!workflow || !workflow.states || !workflow.states.length) {
            wrap.classList.add('is-empty');
            return wrap;
        }
        wrap.appendChild(metricCard('All', state.records.length, 'Records'));
        if (workflow && workflow.states && workflow.states.length) {
            workflow.states.slice(0, 4).forEach(function (status) {
                var count = state.records.filter(function (record) {
                    return String(record.status || '') === status;
                }).length;
                var card = metricCard(humanName(status), count, 'State');
                card.classList.add('status-' + String(status).toLowerCase());
                card.addEventListener('click', function () {
                    state.statusFilter = state.statusFilter === status ? 'all' : status;
                    renderRecordsView();
                });
                wrap.appendChild(card);
            });
        }
        return wrap;
    }

    function metricCard(label, value, hint) {
        var card = el('button', 'external-metric');
        card.type = 'button';
        card.appendChild(el('span', null, label));
        card.appendChild(el('strong', null, value));
        card.appendChild(el('small', null, hint));
        return card;
    }

    function renderWorkbench() {
        var workbench = el('section', 'external-workbench');
        var sidebar = el('aside', 'external-sidebar');
        sidebar.appendChild(el('nav', 'external-app-nav', null)).id = 'external-app-nav';
        workbench.appendChild(sidebar);

        var main = el('main', 'external-main');
        main.appendChild(renderMetrics());
        main.appendChild(el('div', 'external-app-table', null)).id = 'external-app-table';
        var side = el('aside', 'external-side');
        side.appendChild(el('div', 'external-app-form', null)).id = 'external-app-form';
        side.appendChild(el('div', 'external-contact-slot', null)).id = 'external-contact-slot';
        main.appendChild(side);
        workbench.appendChild(main);
        return workbench;
    }

    function rerenderChrome() {
        var oldMetrics = document.getElementById('external-app-dashboard');
        if (oldMetrics) oldMetrics.replaceWith(renderMetrics());
    }

    function renderNav() {
        var nav = document.getElementById('external-app-nav');
        if (!nav) return;
        nav.textContent = '';
        visibleViews().forEach(function (view, index) {
            var button = el('button', 'external-tab' + (index === state.activeView ? ' active' : ''));
            button.type = 'button';
            button.appendChild(el('span', 'external-tab-icon ' + iconClass(view)));
            var label = el('span', 'external-tab-label', humanName(navLabel(view)));
            button.appendChild(label);
            button.appendChild(el('small', null, humanName(view.entity)));
            button.addEventListener('click', function () {
                state.activeView = index;
                state.selected = null;
                state.editMode = false;
                state.statusFilter = 'all';
                state.search = '';
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
            state.editMode = false;
            return loadRelationOptions(entityDef(view.entity));
        }).then(function () {
            rerenderChrome();
            renderRecordsView();
            renderForm();
        }).catch(function (err) {
            renderEmpty(err.message);
        });
    }

    function renderEmpty(message) {
        var table = document.getElementById('external-app-table');
        var form = document.getElementById('external-app-form');
        if (table) {
            table.textContent = '';
            table.appendChild(el('p', 'external-empty', message));
        }
        if (form) form.textContent = '';
    }

    function renderRecordsView() {
        var view = currentView();
        if (!view) return;
        if (view.type === 'kanban') {
            renderKanban(view);
            return;
        }
        if (view.type === 'calendar') {
            renderCalendar(view);
            return;
        }
        renderTable(view);
    }

    function renderTable(view) {
        var entity = entityDef(view.entity);
        var tableWrap = document.getElementById('external-app-table');
        if (!tableWrap) return;
        tableWrap.textContent = '';

        tableWrap.appendChild(renderViewToolbar(view, filteredRecords().length));

        var records = filteredRecords();
        if (!records.length) {
            tableWrap.appendChild(renderEmptyState(state.records.length ? 'No matching records' : 'Nothing here yet', state.records.length ? 'Try a different search or workflow filter.' : 'Create the first record from the panel on the right.'));
            return;
        }

        var columns = view.columns && view.columns.length ? view.columns : (entity && entity.fields || []).map(function (field) {
            return field.name;
        });
        var workflow = workflowFor(view.entity);
        var stateField = workflow && workflow.state_field;
        var hasStatusColumn = stateField && columns.indexOf(stateField) !== -1;
        var table = el('table', 'external-records-table');
        var thead = el('thead');
        var headRow = el('tr');
        columns.forEach(function (column) {
            headRow.appendChild(el('th', null, humanName(column)));
        });
        if (!hasStatusColumn) headRow.appendChild(el('th', null, 'Status'));
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        records.forEach(function (record) {
            var row = el('tr', state.selected && state.selected.id === record.id ? 'selected' : '');
            row.addEventListener('click', function () {
                state.selected = record;
                renderRecordsView();
                renderForm();
            });
            columns.forEach(function (column) {
                var cell = el('td');
                if (column === stateField) {
                    cell.appendChild(el('span', 'external-status-pill status-' + String(record.data[column] || record.status || 'none').toLowerCase(), record.data[column] || record.status || 'none'));
                } else {
                    cell.textContent = fieldDisplayValue(entity, column, record.data[column]);
                }
                row.appendChild(cell);
            });
            if (!hasStatusColumn) {
                var status = el('td');
                status.appendChild(el('span', 'external-status-pill status-' + String(record.status || 'none').toLowerCase(), record.status || 'none'));
                row.appendChild(status);
            }
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        tableWrap.appendChild(table);
    }

    function renderViewToolbar(view, shown) {
        var top = el('div', 'external-table-toolbar');
        var title = el('div', 'external-section-title');
        title.appendChild(el('h2', null, humanName(navLabel(view)) || humanName(view.entity)));
        title.appendChild(el('span', null, shown + (shown === 1 ? ' record' : ' records')));
        top.appendChild(title);
        var search = el('input', 'input external-search');
        search.type = 'search';
        search.placeholder = 'Search records';
        search.value = state.search;
        search.addEventListener('input', function () {
            state.search = search.value;
            renderRecordsView();
        });
        top.appendChild(search);
        return top;
    }

    function primaryRecordTitle(entity, record) {
        var data = record.data || {};
        var preferred = ['title', 'subject', 'name', 'full_name', 'nome'];
        for (var i = 0; i < preferred.length; i++) {
            if (data[preferred[i]]) return valueText(data[preferred[i]]);
        }
        var first = entity && entity.fields && entity.fields[0] ? entity.fields[0].name : null;
        return first && data[first] ? valueText(data[first]) : '#' + record.id;
    }

    function secondaryRecordText(view, record) {
        var data = record.data || {};
        return (view.columns || [])
            .filter(function (column) {
                return data[column] !== undefined && data[column] !== null && data[column] !== '';
            })
            .slice(0, 3)
            .map(function (column) {
                return humanName(column) + ': ' + fieldDisplayValue(entityDef(view.entity), column, data[column]);
            })
            .join(' · ');
    }

    function renderKanban(view) {
        var entity = entityDef(view.entity);
        var workflow = workflowFor(view.entity);
        var tableWrap = document.getElementById('external-app-table');
        if (!tableWrap) return;
        tableWrap.textContent = '';
        tableWrap.appendChild(renderViewToolbar(view, filteredRecords().length));
        if (!workflow || !workflow.states || !workflow.states.length) {
            tableWrap.appendChild(renderEmptyState('Board unavailable', 'This view needs workflow states.'));
            return;
        }

        var records = filteredRecords();
        var board = el('section', 'external-kanban');
        workflow.states.forEach(function (status) {
            var items = records.filter(function (record) {
                return String(record.status || record.data[workflow.state_field] || '') === status;
            });
            var column = el('article', 'external-kanban-column status-' + String(status).toLowerCase());
            var header = el('div', 'external-kanban-header');
            header.appendChild(el('h3', null, humanName(status)));
            header.appendChild(el('span', null, items.length));
            column.appendChild(header);
            if (!items.length) column.appendChild(el('p', 'external-kanban-empty', 'No records'));
            items.forEach(function (record) {
                var card = el('button', 'external-kanban-card' + (state.selected && state.selected.id === record.id ? ' selected' : ''));
                card.type = 'button';
                card.appendChild(el('strong', null, primaryRecordTitle(entity, record)));
                var meta = secondaryRecordText(view, record);
                if (meta) card.appendChild(el('span', null, meta));
                card.addEventListener('click', function () {
                    state.selected = record;
                    renderRecordsView();
                    renderForm();
                });
                column.appendChild(card);
            });
            board.appendChild(column);
        });
        tableWrap.appendChild(board);
    }

    function calendarDateField(entity, view) {
        var fields = entity && entity.fields ? entity.fields : [];
        var columns = view.columns || [];
        for (var i = 0; i < columns.length; i++) {
            var columnField = fields.find(function (field) { return field.name === columns[i]; });
            if (columnField && columnField.type === 'date') return columnField.name;
        }
        var firstDate = fields.find(function (field) { return field.type === 'date'; });
        return firstDate ? firstDate.name : null;
    }

    function renderCalendar(view) {
        var entity = entityDef(view.entity);
        var tableWrap = document.getElementById('external-app-table');
        if (!tableWrap) return;
        tableWrap.textContent = '';
        tableWrap.appendChild(renderCalendarToolbar(view, filteredRecords().length));
        var dateField = calendarDateField(entity, view);
        if (!dateField) {
            tableWrap.appendChild(renderEmptyState('Calendar unavailable', 'This view needs a date field.'));
            return;
        }
        tableWrap.appendChild(renderMonthCalendar(view, entity, dateField));
    }

    function renderCalendarToolbar(view, shown) {
        var top = renderViewToolbar(view, shown);
        var controls = el('div', 'external-calendar-controls');
        var previous = el('button', 'external-secondary-action', 'Previous');
        previous.type = 'button';
        previous.addEventListener('click', function () {
            state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
            renderRecordsView();
        });
        var current = el('strong', null, state.calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
        var next = el('button', 'external-secondary-action', 'Next');
        next.type = 'button';
        next.addEventListener('click', function () {
            state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
            renderRecordsView();
        });
        controls.appendChild(previous);
        controls.appendChild(current);
        controls.appendChild(next);
        top.appendChild(controls);
        return top;
    }

    function renderMonthCalendar(view, entity, dateField) {
        var grid = el('section', 'external-calendar-grid');
        ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(function (day) {
            grid.appendChild(el('div', 'external-calendar-weekday', day));
        });
        var year = state.calendarMonth.getFullYear();
        var month = state.calendarMonth.getMonth();
        var first = new Date(year, month, 1);
        var leading = (first.getDay() + 6) % 7;
        var days = new Date(year, month + 1, 0).getDate();
        for (var i = 0; i < leading; i++) {
            grid.appendChild(el('div', 'external-calendar-day is-muted'));
        }
        for (var day = 1; day <= days; day++) {
            var date = dateKey(new Date(year, month, day));
            var cell = el('div', 'external-calendar-day');
            cell.dataset.date = date;
            cell.addEventListener('dragover', function (event) {
                event.preventDefault();
                this.classList.add('is-drop-target');
            });
            cell.addEventListener('dragleave', function () {
                this.classList.remove('is-drop-target');
            });
            cell.addEventListener('drop', function (event) {
                event.preventDefault();
                this.classList.remove('is-drop-target');
                var recordId = event.dataTransfer.getData('text/plain');
                if (recordId) moveCalendarRecord(view, recordId, dateField, this.dataset.date);
            });
            cell.appendChild(el('span', 'external-calendar-date', day));
            filteredRecords().filter(function (record) {
                return String(record.data[dateField] || '') === date;
            }).forEach(function (record) {
                cell.appendChild(renderCalendarEvent(view, entity, record));
            });
            grid.appendChild(cell);
        }
        return grid;
    }

    function renderCalendarEvent(view, entity, record) {
        var event = el('button', 'external-calendar-event' + (state.selected && state.selected.id === record.id ? ' selected' : ''));
        event.type = 'button';
        event.draggable = true;
        event.appendChild(el('strong', null, primaryRecordTitle(entity, record)));
        var meta = secondaryRecordText(view, record);
        if (meta) event.appendChild(el('span', null, meta));
        event.addEventListener('dragstart', function (dragEvent) {
            dragEvent.dataTransfer.setData('text/plain', String(record.id));
            dragEvent.dataTransfer.effectAllowed = 'move';
        });
        event.addEventListener('click', function () {
            state.selected = record;
            renderRecordsView();
            renderForm();
        });
        return event;
    }

    function dateKey(date) {
        var month = String(date.getMonth() + 1).padStart(2, '0');
        var day = String(date.getDate()).padStart(2, '0');
        return date.getFullYear() + '-' + month + '-' + day;
    }

    function moveCalendarRecord(view, recordId, dateField, date) {
        var payload = { data: {} };
        payload.data[dateField] = date;
        api('/entities/' + encodeURIComponent(view.entity) + '/records/' + encodeURIComponent(recordId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function () {
            loadRecords();
        }).catch(function (err) {
            window.alert(err.message);
        });
    }

    function renderEmptyState(title, message) {
        var empty = el('section', 'external-empty-state');
        var illustration = el('div', 'external-empty-illustration');
        illustration.appendChild(el('span'));
        illustration.appendChild(el('span'));
        illustration.appendChild(el('span'));
        illustration.appendChild(el('i'));
        empty.appendChild(illustration);
        empty.appendChild(el('h3', null, title));
        empty.appendChild(el('p', null, message));
        return empty;
    }

    function renderForm() {
        var view = currentView();
        var entity = entityDef(view.entity);
        var formWrap = document.getElementById('external-app-form');
        if (!formWrap) return;
        formWrap.textContent = '';
        if (!entity) {
            formWrap.appendChild(el('p', 'external-empty', 'Entity not found.'));
            return;
        }

        var title = el('div', 'external-form-title');
        title.appendChild(el('span', null, 'Quick create'));
        title.appendChild(el('h2', null, entity.label || humanName(entity.name)));
        formWrap.appendChild(title);

        var form = el('form', 'external-record-form');
        var writableFields = formFields(entity, workflowFor(entity.name));
        writableFields.forEach(function (field) {
            form.appendChild(renderField(field));
        });

        var error = el('p', 'external-error');
        var submit = el('button', 'external-primary-action', 'Create ' + humanName(entity.label || entity.name));
        submit.type = 'submit';
        form.appendChild(submit);
        form.appendChild(error);
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            error.textContent = '';
            api('/entities/' + encodeURIComponent(view.entity) + '/records', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: formData(writableFields, form) })
            }).then(function () {
                form.reset();
                state.selected = null;
                state.editMode = false;
                loadRecords();
            }).catch(function (err) {
                error.textContent = err.message;
            });
        });
        formWrap.appendChild(form);
        renderSelected(formWrap, view, entity);
        renderEditForm(formWrap, view, entity);
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
        } else if (field.type === 'relation' && field.to) {
            input = el('select', 'input');
            var blank = el('option', null, 'Select ' + humanName(field.to));
            blank.value = '';
            input.appendChild(blank);
            (state.relatedRecords[field.to] || []).forEach(function (record) {
                var item = el('option', null, primaryRecordTitle(entityDef(field.to), record));
                item.value = record.id;
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
        if (field.type === 'boolean') label.classList.add('external-field-boolean');
        input.name = field.name;
        input.required = !!field.required;
        if (field.default !== undefined && field.default !== null && input.type !== 'checkbox') {
            input.value = field.default;
        }
        if (input.type === 'checkbox') input.checked = !!field.default;
        label.appendChild(input);
        return label;
    }

    function relationTargets(entity) {
        var seen = {};
        return (entity && entity.fields ? entity.fields : []).filter(function (field) {
            if (field.type !== 'relation' || !field.to || seen[field.to]) return false;
            seen[field.to] = true;
            return true;
        }).map(function (field) { return field.to; });
    }

    function loadRelationOptions(entity) {
        var targets = relationTargets(entity).filter(function (target) {
            return !state.relatedRecords[target];
        });
        if (!targets.length) return Promise.resolve();
        return Promise.all(targets.map(function (target) {
            return api('/entities/' + encodeURIComponent(target) + '/records')
                .then(function (records) {
                    state.relatedRecords[target] = records || [];
                })
                .catch(function () {
                    state.relatedRecords[target] = [];
                });
        }));
    }

    function formData(fields, form) {
        var data = {};
        fields.forEach(function (field) {
            var input = form.elements[field.name];
            if (!input) return;
            if (field.type === 'boolean') data[field.name] = !!input.checked;
            else if (field.type === 'number') data[field.name] = input.value === '' ? null : Number(input.value);
            else data[field.name] = input.value;
        });
        return data;
    }

    function renderSelected(container, view, entity) {
        if (!state.selected) return;
        var detail = el('section', 'external-selected');
        detail.appendChild(el('h3', null, 'Selected item'));
        (entity.fields || []).slice(0, 6).forEach(function (field) {
            var row = el('div', 'external-detail-row');
            row.appendChild(el('span', null, field.label || humanName(field.name)));
            row.appendChild(el('strong', null, fieldDisplayValue(entity, field.name, state.selected.data[field.name])));
            detail.appendChild(row);
        });
        var status = selectedStatus(view);
        if (status) {
            var row = el('div', 'external-detail-row');
            row.appendChild(el('span', null, 'Status'));
            row.appendChild(el('strong', null, status));
            detail.appendChild(row);
        }
        var actions = el('div', 'external-actions');
        var edit = el('button', 'external-secondary-action', state.editMode ? 'Cancel edit' : 'Edit');
        edit.type = 'button';
        edit.addEventListener('click', function () {
            state.editMode = !state.editMode;
            renderForm();
        });
        actions.appendChild(edit);
        var remove = el('button', 'external-danger-action', 'Delete');
        remove.type = 'button';
        remove.addEventListener('click', function () {
            deleteSelectedRecord(view);
        });
        actions.appendChild(remove);
        detail.appendChild(actions);
        container.appendChild(detail);
    }

    function renderEditForm(container, view, entity) {
        if (!state.selected || !state.editMode) return;
        var section = el('section', 'external-edit');
        section.appendChild(el('h3', null, 'Edit item'));
        var form = el('form', 'external-record-form');
        var writableFields = formFields(entity, workflowFor(entity.name));
        writableFields.forEach(function (field) {
            var fieldNode = renderField(field);
            var input = fieldNode.querySelector('[name="' + field.name + '"]');
            var value = state.selected.data[field.name];
            if (input) {
                if (field.type === 'boolean') input.checked = !!value;
                else if (value !== undefined && value !== null) input.value = value;
            }
            form.appendChild(fieldNode);
        });
        var error = el('p', 'external-error');
        var save = el('button', 'external-primary-action', 'Save changes');
        save.type = 'submit';
        form.appendChild(save);
        form.appendChild(error);
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            error.textContent = '';
            var merged = Object.assign({}, state.selected.data, formData(writableFields, form));
            api('/entities/' + encodeURIComponent(view.entity) + '/records/' + state.selected.id, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: merged })
            }).then(function () {
                state.editMode = false;
                return loadRecords();
            }).catch(function (err) {
                error.textContent = err.message;
            });
        });
        section.appendChild(form);
        container.appendChild(section);
    }

    function deleteSelectedRecord(view) {
        if (!state.selected) return;
        if (!window.confirm('Delete this record?')) return;
        api('/entities/' + encodeURIComponent(view.entity) + '/records/' + state.selected.id, {
            method: 'DELETE'
        }).then(function () {
            state.selected = null;
            state.editMode = false;
            return loadRecords();
        }).catch(function (err) {
            window.alert(err.message);
        });
    }

    function renderActions(container, view) {
        var workflow = workflowFor(view.entity);
        if (!workflow || !state.selected) return;
        var status = selectedStatus(view);
        var transitions = (workflow.transitions || []).filter(function (transition) {
            return transition.from === status && roleAllowed(transition.roles);
        });
        if (!transitions.length) return;

        var actions = el('div', 'external-actions');
        actions.appendChild(el('h3', null, 'Available actions'));
        transitions.forEach(function (transition) {
            var button = el('button', 'external-secondary-action', transition.label || humanName(transition.name));
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
        api('/contacts').then(function (contacts) {
            state.contacts = contacts || [];
            renderContacts();
        }).catch(function () {
            state.contacts = [];
            renderContacts();
        });
    }

    function renderContacts() {
        var slot = document.getElementById('external-contact-slot');
        if (!slot) return;
        slot.textContent = '';
        if (!state.contacts.length) return;
        var panel = el('section', 'external-contacts-panel');
        var title = el('div', 'external-section-title');
        title.appendChild(el('h2', null, 'Allowed contacts'));
        title.appendChild(el('span', null, state.contacts.length + ' available'));
        panel.appendChild(title);
        var list = el('div', 'external-contact-list');
        state.contacts.slice(0, 6).forEach(function (contact) {
            var item = el('article', 'external-contact-card');
            item.appendChild(el('strong', null, contact.name));
            if (contact.nickname) item.appendChild(el('span', null, contact.nickname));
            if (contact.preferred_channel) item.appendChild(el('small', null, contact.preferred_channel));
            list.appendChild(item);
        });
        panel.appendChild(list);
        slot.appendChild(panel);
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

    api('/meta').then(function (meta) {
        state.app = meta;
        renderApp();
    }).catch(function () {
        location.href = '/a/' + encodeURIComponent(slug) + '/login';
    });
}());
