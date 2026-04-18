// Homun — Shared Model Loader
// Fetches LLM models from all configured providers and populates <select> elements.
// Used by: chat.js, automations.js, setup.js — single source of truth for model loading.

window.ModelLoader = {

    PROVIDER_NAMES: {
        anthropic: 'Anthropic',
        openai: 'OpenAI',
        gemini: 'Google Gemini',
        openrouter: 'OpenRouter',
        deepseek: 'DeepSeek',
        groq: 'Groq',
        mistral: 'Mistral',
        xai: 'xAI',
        together: 'Together',
        ollama: 'Ollama (local)',
        ollama_cloud: 'Ollama Cloud',
        fireworks: 'Fireworks',
        perplexity: 'Perplexity',
        cohere: 'Cohere',
        venice: 'Venice',
        aihubmix: 'AiHubMix',
        vllm: 'vLLM',
        custom: 'Custom',
    },

    // Cache to avoid redundant API calls within a session
    _cache: null,

    // Favorites cache (Set of full model ids). Refreshed by getFavorites() / toggleFavorite()
    // Listeners (subscribed via onFavoritesChange) are notified after the set mutates.
    _favorites: null,
    _favoritesListeners: [],

    /**
     * Fetch all available LLM models grouped by provider.
     * Calls /api/v1/providers/models for static models,
     * plus Ollama local/cloud endpoints for live model lists.
     *
     * @param {Object} [opts]
     * @param {boolean} [opts.fresh] - Bypass cache and re-fetch
     * @returns {Promise<{groups: Object, raw: Object}>}
     *   groups: { providerKey: [{value, label}] }
     *   raw: original /providers/models response
     */
    async fetchGrouped(opts) {
        if (this._cache && !(opts && opts.fresh)) return this._cache;

        var res = await fetch('/api/v1/providers/models');
        var data = await res.json();

        // Group static models by provider
        var groups = {};
        (data.models || []).forEach(function(m) {
            var key = m.provider;
            if (!groups[key]) groups[key] = [];
            groups[key].push({ value: m.model, label: m.label || m.model });
        });

        // Fetch live Ollama local models
        if (data.ollama_configured) {
            try {
                var olResp = await fetch('/api/v1/providers/ollama/models');
                var olData = await olResp.json();
                if (olData.ok && Array.isArray(olData.models) && olData.models.length > 0) {
                    groups['ollama'] = olData.models.map(function(m) {
                        return {
                            value: 'ollama/' + m.name,
                            label: m.name + (m.size ? ' (' + m.size + ')' : ''),
                        };
                    });
                }
            } catch (_) { /* Ollama might not be running */ }
        }

        // Fetch live Ollama Cloud models
        if (data.ollama_cloud_configured) {
            try {
                var ocResp = await fetch('/api/v1/providers/ollama-cloud/models');
                var ocData = await ocResp.json();
                if (ocData.ok && Array.isArray(ocData.models) && ocData.models.length > 0) {
                    groups['ollama_cloud'] = ocData.models.map(function(m) {
                        return {
                            value: 'ollama_cloud/' + m.id,
                            label: m.id,
                        };
                    });
                }
            } catch (_) { /* Ollama Cloud might not be reachable */ }
        }

        this._cache = { groups: groups, raw: data };
        return this._cache;
    },

    // ────────────────────────────────────────────────────────────────
    // Favorites — user-curated set of full model ids, cross-provider.
    // Surfaced at the top of every dropdown via the ⭐ group.
    // ────────────────────────────────────────────────────────────────

    /**
     * Fetch the favorites set, cached across the session.
     * @returns {Promise<Set<string>>} set of full model ids
     */
    async getFavorites() {
        if (this._favorites !== null) return this._favorites;
        try {
            var res = await fetch('/api/v1/favorites/models');
            if (!res.ok) {
                this._favorites = new Set();
                return this._favorites;
            }
            var data = await res.json();
            this._favorites = new Set(Array.isArray(data.models) ? data.models : []);
        } catch (_) {
            this._favorites = new Set();
        }
        return this._favorites;
    },

    /**
     * Toggle a model id in the user's favorites set.
     * Implements: optimistic UI update → POST → rollback on error → notify listeners.
     *
     * Steps to implement (~10 lines):
     *  1. Ensure local cache is populated (await this.getFavorites()).
     *  2. Compute the optimistic new state (add if missing, remove if present)
     *     and apply it to this._favorites BEFORE the network call so the UI
     *     re-renders immediately (snappy UX).
     *  3. POST to '/api/v1/favorites/models/toggle' with body { model: modelId }.
     *  4. If response.ok: trust the server's authoritative list (response.models)
     *     and overwrite this._favorites = new Set(response.models).
     *  5. If response NOT ok or network throws: ROLLBACK to the pre-change state
     *     so the UI snaps back, and re-throw / log the error.
     *  6. Always call this._notifyFavoritesChange() at the end of the success path
     *     so subscribed components (chat picker, settings dropdown) re-render.
     *  7. Return the resulting boolean: true if the model is now favorited, false otherwise.
     *
     * Why optimistic? The whole point of favorites UX is "feels instant". If we wait
     * for the round-trip the star takes 200-500ms to fill — that's not "less is more",
     * that's laggy. The trade-off: we must handle rollback cleanly on error.
     *
     * @param {string} modelId - Full provider-prefixed id, e.g. "ollama/qwen3.5:397b-cloud"
     * @returns {Promise<boolean>} true if now favorited, false if removed
     */
    async toggleFavorite(modelId) {
        // TODO(user): implement following the steps above.
        // The feature works once you fill this in — backend + UI are ready.
        throw new Error('toggleFavorite() not yet implemented — see comment above');
    },

    /** Subscribe to favorites changes. Returns unsubscribe fn. */
    onFavoritesChange(listener) {
        this._favoritesListeners.push(listener);
        return () => {
            this._favoritesListeners = this._favoritesListeners.filter(l => l !== listener);
        };
    },

    /** Internal: notify subscribers after favorites mutate. */
    _notifyFavoritesChange() {
        var snapshot = this._favorites ? new Set(this._favorites) : new Set();
        this._favoritesListeners.forEach(function(l) {
            try { l(snapshot); } catch (e) { console.error('favorites listener error', e); }
        });
    },

    /** Clear cached favorites (e.g. on auth change or external mutation). */
    clearFavoritesCache() {
        this._favorites = null;
    },

    /**
     * Populate a <select> element with optgroups from model groups.
     * If favorites are loaded, renders a "⭐ Favorites" optgroup at the top
     * containing all model values that match the user's favorite set, in
     * the order they appear in the favorites list.
     *
     * @param {HTMLSelectElement} selectEl - The select to populate
     * @param {Object} groups - { providerKey: [{value, label}] }
     * @param {string} currentModel - Currently selected model value
     * @param {string} [defaultText] - Text for the default empty option
     */
    populateSelect: function(selectEl, groups, currentModel, defaultText) {
        selectEl.textContent = '';

        var defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = defaultText || '-- Default model --';
        if (!currentModel) defOpt.selected = true;
        selectEl.appendChild(defOpt);

        // ⭐ Favorites group at top (read from cache; null = not loaded yet, so skip)
        var favorites = this._favorites;
        if (favorites && favorites.size > 0) {
            // Build a value→label index from groups so favorites can show provider context
            var labelByValue = {};
            for (var p in groups) {
                if (!groups.hasOwnProperty(p)) continue;
                groups[p].forEach(function(m) { labelByValue[m.value] = m.label; });
            }
            var favGroup = document.createElement('optgroup');
            favGroup.label = '⭐ Favorites';
            // Render in insertion order from the set (preserves user toggle order)
            favorites.forEach(function(modelValue) {
                if (!labelByValue.hasOwnProperty(modelValue)) return; // skip stale ids
                var opt = document.createElement('option');
                opt.value = modelValue;
                opt.textContent = labelByValue[modelValue];
                if (currentModel === modelValue) opt.selected = true;
                favGroup.appendChild(opt);
            });
            if (favGroup.childNodes.length > 0) selectEl.appendChild(favGroup);
        }

        var providerNames = this.PROVIDER_NAMES;
        for (var provider in groups) {
            if (!groups.hasOwnProperty(provider)) continue;
            var models = groups[provider];
            var optgroup = document.createElement('optgroup');
            optgroup.label = providerNames[provider] || provider;
            models.forEach(function(m) {
                var opt = document.createElement('option');
                opt.value = m.value;
                opt.textContent = m.label;
                if (currentModel === m.value) opt.selected = true;
                optgroup.appendChild(opt);
            });
            selectEl.appendChild(optgroup);
        }

        if (Object.keys(groups).length === 0) {
            defOpt.textContent = 'No models configured';
        }
    },

    /** Clear cached models (e.g. after provider config changes). */
    clearCache: function() {
        this._cache = null;
    },
};

// Auto-load favorites once at script init so populateSelect() picks them up
// the first time it's called. Best-effort; failures fall back to empty set.
if (window.ModelLoader && typeof window.ModelLoader.getFavorites === 'function') {
    window.ModelLoader.getFavorites().catch(function() { /* tolerated */ });
}
