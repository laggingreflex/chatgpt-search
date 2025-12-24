import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import MiniSearch from 'minisearch';
import Markdown from 'react-markdown';
import ReadMe from '../README.md?raw';

const logPrefix = '[chatgpt-search]';

// Storage schema/versioning
// Bump this when changing how/where we persist data.
const STORAGE_SCHEMA_VERSION = 2;
const STORAGE_SCHEMA_KEY = 'chatgpt-search:storage-schema-version';
const CACHE_NAME = `chatgpt-search-cache-v${STORAGE_SCHEMA_VERSION}`;
// Known previous cache names (kept for migration/cleanup).
const LEGACY_CACHE_NAMES = ['myCache', 'chatgpt-search-cache-v1'];

let didInit = false;
const root = createRoot(document.getElementById('app') || document.body);
root.render(<App />);

/* Components */

function App() {
  const [conversations, setConversations] = useState([]);
  const [selectedConversations, setSelectedConversations] = useState(new Set());
  const [input, setInput] = useState('');
  const [fuzzy, setFuzzy] = useState(true); // State for fuzzy search toggle
  const [loading, setLoading] = useState(false);
  const [miniSearch, setMiniSearch] = useState(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [settings, setSettings] = useState({
    mergeDownload: false,
    keepFilteredSelected: false,
    sortBy: 'updated',
  });
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (!didInit) {
      didInit = true;
      (async () => {
        setLoading(true);
        try {
          await ensureStorageUpToDate();
          console.debug(logPrefix, 'init: restoring cached conversations');
          const c = await cacheGetJson('json');
          console.debug(logPrefix, 'init: cached conversations restored', {
            count: Array.isArray(c) ? c.length : undefined,
          });
          setConversations(c || []);
        } finally {
          setLoading(false);
        }
      })();
    }
  });

  useEffect(() => {
    let cancelled = false;

    const miniSearchOptions = {
      fields: ['title', 'text'],
      // Include `time` so we can sort fuzzy results by created date too.
      storeFields: ['id', 'title', 'updated', 'time'],
    };

    const signature = getConversationsSignature(conversations);

    console.debug(logPrefix, 'index: effect', {
      conversationsCount: conversations?.length ?? 0,
      signature,
    });

    if (!conversations?.length) {
      setMiniSearch(null);
      setIsIndexing(false);
      return;
    }

    (async () => {
      setIsIndexing(true);
      try {
        // 1) Try restore persisted index for this exact dataset signature.
        console.debug(logPrefix, 'index: attempting restore', { signature });
        const restored = await restoreMiniSearchIndex({ signature, miniSearchOptions });
        if (restored) {
          if (cancelled) return;
          console.debug(logPrefix, 'index: restored persisted index', { signature });
          setMiniSearch(restored);
          return;
        }

        // 2) Build index if restore is unavailable/mismatched.
        console.debug(logPrefix, 'index: building index', { signature });
        const nextMiniSearch = new MiniSearch(miniSearchOptions);
        await nextMiniSearch.addAllAsync(conversations);
        if (cancelled) return;
        setMiniSearch(nextMiniSearch);

        console.debug(logPrefix, 'index: built index; persisting', { signature });

        // 3) Persist the freshly-built index.
        await persistMiniSearchIndex({ signature, miniSearchOptions, miniSearch: nextMiniSearch });
        console.debug(logPrefix, 'index: persisted index', { signature });
      } finally {
        if (!cancelled) setIsIndexing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversations]);

  const toggleSelectConversation = conversationId => {
    setSelectedConversations(prevSelected => {
      const updatedSelected = new Set(prevSelected);
      if (updatedSelected.has(conversationId)) {
        updatedSelected.delete(conversationId);
      } else {
        updatedSelected.add(conversationId);
      }
      return updatedSelected;
    });
  };

  const downloadSelectedConversations = () => {
    const selected = conversations.filter(c => selectedConversations.has(c.id));
    if (selected.length > 0) {
      if (settings.mergeDownload) {
        const combinedText = selected.map(c => `# ${c.title}\n\n${c.text}`).join('\n\n---\n\n');
        downloadMarkdown(combinedText, 'selected_conversations.md');
      } else {
        const zip = new JSZip();
        selected.forEach(c => {
          zip.file(`${c.title}.md`, c.text);
        });
        zip.generateAsync({ type: 'blob' }).then(content => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(content);
          a.download = 'selected_conversations.zip';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(a.href);
        });
      }
    }
  };

  const isBusy = loading || isIndexing;

  return (
    <div className={['app', isBusy ? 'loading' : 'loaded'].filter(Boolean).join(' ')}>
      <h1>ChatGPT Search</h1>
      <button className='settings-button' onClick={() => setShowSettings(!showSettings)}>
        ⚙️
      </button>
      {showSettings && (
        <div className='settings-popup'>
          <h2>Settings</h2>
          <label>
            Sort results by:{' '}
            <select
              value={settings.sortBy}
              onChange={e => setSettings(prev => ({ ...prev, sortBy: e.target.value }))}>
              <option value='relevance'>Relevance</option>
              <option value='updated'>Updated date (newest first)</option>
              <option value='created'>Created date (newest first)</option>
            </select>
          </label>
          <label>
            <input
              type='checkbox'
              checked={settings.mergeDownload}
              onChange={e => setSettings(prev => ({ ...prev, mergeDownload: e.target.checked }))}
            />{' '}
            Merge downloads as a single Markdown file
          </label>
          <label>
            <input
              type='checkbox'
              checked={settings.keepFilteredSelected}
              onChange={e => setSettings(prev => ({ ...prev, keepFilteredSelected: e.target.checked }))}
            />{' '}
            Keep filtered items selected
          </label>
        </div>
      )}
      {isBusy && (
        <pre className='loading'>
          {loading && isIndexing
            ? 'Loading & preparing your search index..'
            : loading
              ? 'Loading your saved conversations..'
              : 'Preparing your search index..'}
        </pre>
      )}
      {!conversations.length && (
        <p>
          Goto <a href='https://chat.openai.com/#settings/DataControls'>ChatGPT » Export data</a> and upload (the
          zip file) here, then you can search through all your conversations.
        </p>
      )}
      {!!conversations?.length && (
        <>
          <input name='search' type='text' autoFocus onChange={onType} />
          <label>
            <input type='checkbox' checked={fuzzy} onChange={e => setFuzzy(e.target.checked)} /> Fuzzy Search
          </label>
          <SearchResults
            input={input}
            conversations={conversations}
            fuzzy={fuzzy}
            miniSearch={miniSearch}
            toggleSelectConversation={toggleSelectConversation}
            selectedConversations={selectedConversations}
            settings={settings}
            setSelectedConversations={setSelectedConversations}
          />
          <button onClick={downloadSelectedConversations} disabled={!selectedConversations.size}>
            Download Selected Conversations
          </button>
        </>
      )}
      <label className='input file'>
        Upload your ChatGPT data
        <input name='file' type='file' onChange={onFile} accept='.zip' />
      </label>
      {!conversations.length && <Markdown>{ReadMe}</Markdown>}
    </div>
  );

  async function onType(e) {
    const text = e.target.value;
    setInput(text);
  }

  async function onFile(e) {
    try {
      setLoading(true);
      const file = e.target.files[0];
      if (!file) return;

      console.debug(logPrefix, 'file: selected', {
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      });

      const conversations = await processFile(file);
      console.debug(logPrefix, 'file: processed', {
        conversationsCount: conversations?.length ?? 0,
      });
      setConversations(conversations);
      await cachePutFile(file, 'file');
      await cachePutJson(conversations, 'json');
      console.debug(logPrefix, 'file: cached conversations + source zip');
    } finally {
      setLoading(false);
    }
  }
}

function SearchResults({
  input,
  conversations,
  fuzzy,
  miniSearch,
  toggleSelectConversation,
  selectedConversations,
  setSelectedConversations,
  settings,
}) {
  useEffect(() => {
    if (!settings.keepFilteredSelected) {
      setSelectedConversations(prevSelected => {
        const updatedSelected = new Set(
          Array.from(prevSelected).filter(id => conversations.some(c => c.id === id)),
        );
        return updatedSelected;
      });
    }
  }, [settings.keepFilteredSelected, conversations]);

  let showing = [];

  if (input.trim()) {
    if (fuzzy) {
      if (miniSearch) {
        const options = {}; // Default options for fuzzy search
        showing = miniSearch.search(input.trim(), options) ?? [];
      }
    } else {
      // Exact match search (case-insensitive)
      const lowerInput = input.toLowerCase();
      showing = conversations.filter(
        c => c.text.toLowerCase().includes(lowerInput) || c.title.toLowerCase().includes(lowerInput),
      );
    }

    // Sort results (relevance / updated / created)
    const sortBy = settings?.sortBy || 'updated';

    if (sortBy === 'relevance') {
      if (fuzzy) {
        // MiniSearch returns results in relevance order; keep it stable and tie-break by updated.
        showing.sort((a, b) => {
          const scoreA = Number(a?.score ?? 0);
          const scoreB = Number(b?.score ?? 0);
          if (scoreB !== scoreA) return scoreB - scoreA;
          return getUpdated(b) - getUpdated(a);
        });
      } else {
        // Exact match results aren't ranked; compute a lightweight relevance score.
        const q = input.trim().toLowerCase();
        showing.sort((a, b) => {
          const scoreA = getExactMatchScore(a, q);
          const scoreB = getExactMatchScore(b, q);
          if (scoreB !== scoreA) return scoreB - scoreA;
          return getUpdated(b) - getUpdated(a);
        });
      }
    } else if (sortBy === 'created') {
      showing.sort((a, b) => {
        const diff = getCreated(b) - getCreated(a);
        if (diff) return diff;
        // Tie-break: if fuzzy search has a score, keep more relevant first.
        const scoreA = Number(a?.score ?? 0);
        const scoreB = Number(b?.score ?? 0);
        return scoreB - scoreA;
      });
    } else {
      // Default: updated date (newest first)
      showing.sort((a, b) => {
        const diff = getUpdated(b) - getUpdated(a);
        if (diff) return diff;
        const scoreA = Number(a?.score ?? 0);
        const scoreB = Number(b?.score ?? 0);
        return scoreB - scoreA;
      });
    }
  }

  return (
    <>
      <p className='search-results'>
        Showing {showing.length} of {conversations?.length ?? 0} conversations
      </p>
      <ol className='search-results'>
        {showing.map(c => (
          <li key={c.id}>{map(c)}</li>
        ))}
      </ol>
    </>
  );

  function map(c) {
    const date = new Date(c.updated * 1000).toLocaleString();
    const con = conversations.find(con => con.id === c.id);
    return (
      <>
        <input
          type='checkbox'
          checked={selectedConversations.has(c.id)}
          onChange={() => toggleSelectConversation(c.id)}
        />
        <a href={`https://chat.openai.com/c/${c.id}`}>{c.title}</a> <span>({date})</span>
        <span> </span>
        <button
          className='download'
          title='Download conversation as markdown'
          onClick={() => downloadMarkdown(con.text, `${c.title}.md`)}>
          💾
        </button>
      </>
    );
  }

  function getUpdated(c) {
    return Number(c?.updated ?? 0);
  }

  function getCreated(c) {
    return Number(c?.time ?? 0);
  }

  function getExactMatchScore(conversation, q) {
    if (!q) return 0;
    const title = String(conversation?.title ?? '').toLowerCase();
    const text = String(conversation?.text ?? '').toLowerCase();
    return countOccurrences(title, q) * 5 + countOccurrences(text, q);
  }

  function countOccurrences(haystack, needle) {
    if (!haystack || !needle) return 0;
    let count = 0;
    let i = 0;
    while (true) {
      i = haystack.indexOf(needle, i);
      if (i === -1) break;
      count++;
      i += needle.length;
    }
    return count;
  }
}

/* Helpers */

async function cacheGetFile(key = 'file', cacheName = CACHE_NAME) {
  // console.time(`${logPrefix} cacheGetFile`);
  const cache = await caches.open(cacheName);
  const response = await cache.match(normalizeCacheKey(key));
  const blob = await response?.blob();
  // console.timeEnd(`${logPrefix} cacheGetFile`);
  return blob;
}

async function ensureStorageUpToDate() {
  // If Cache Storage isn't available (rare, but possible), don't block the app.
  if (typeof caches === 'undefined') return;

  let previous = null;
  try {
    const raw = localStorage.getItem(STORAGE_SCHEMA_KEY);
    previous = raw == null ? null : Number(raw);
  } catch {
    // localStorage can throw in some privacy modes; treat as unknown.
    previous = null;
  }

  if (previous === STORAGE_SCHEMA_VERSION) return;

  console.debug(logPrefix, 'storage: schema upgrade', {
    from: previous,
    to: STORAGE_SCHEMA_VERSION,
    cacheName: CACHE_NAME,
  });

  try {
    await migrateLegacyCaches();
  } catch (err) {
    console.warn(logPrefix, 'storage: legacy cache migration failed', err);
  }

  try {
    cleanupLegacyLocalStorage();
  } catch (err) {
    console.warn(logPrefix, 'storage: localStorage cleanup failed', err);
  }

  try {
    localStorage.setItem(STORAGE_SCHEMA_KEY, String(STORAGE_SCHEMA_VERSION));
  } catch {
    // Ignore.
  }
}

function cleanupLegacyLocalStorage() {
  // We don't rely on localStorage anymore, but older versions might have left
  // behind bulky/invalid entries. Keep the cleanup conservative.
  if (typeof localStorage === 'undefined') return;

  const shouldRemove = key => {
    if (!key) return false;
    // Our keys (past/present) should be namespaced.
    if (key.startsWith('chatgpt-search')) return true;
    // MiniSearch-related leftovers from older experiments.
    if (key.startsWith('minisearch:') || key.startsWith('minisearch-')) return true;
    return false;
  };

  // Iterate backwards because we're mutating while iterating.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (shouldRemove(k)) localStorage.removeItem(k);
  }
}

async function migrateLegacyCaches() {
  const cacheNames = await caches.keys();
  const existing = new Set(cacheNames);

  // Clean up any older versioned caches we used previously.
  for (const name of cacheNames) {
    if (name.startsWith('chatgpt-search-cache-v') && name !== CACHE_NAME) {
      console.debug(logPrefix, 'storage: deleting old versioned cache', { name });
      await caches.delete(name);
    }
  }

  const toCache = await caches.open(CACHE_NAME);

  for (const legacyName of LEGACY_CACHE_NAMES) {
    if (!existing.has(legacyName)) continue;

    console.debug(logPrefix, 'storage: migrating legacy cache', {
      from: legacyName,
      to: CACHE_NAME,
    });

    try {
      await migrateCacheEntries({ fromCacheName: legacyName, toCache });
    } finally {
      // Regardless of migration success, delete legacy cache to prevent the app from
      // being bogged down by stale/broken formats.
      await caches.delete(legacyName);
    }
  }
}

async function migrateCacheEntries({ fromCacheName, toCache }) {
  const fromCache = await caches.open(fromCacheName);

  // Conversations + source zip.
  await copyCacheEntry({ fromCache, toCache, key: 'json' });
  await copyCacheEntry({ fromCache, toCache, key: 'file' });

  // MiniSearch index (best-effort).
  const metaRequest = normalizeCacheKey(MINISEARCH_META_KEY);
  const existingMeta = await toCache.match(metaRequest);
  if (!existingMeta) {
    const metaResponse = await fromCache.match(metaRequest);
    if (metaResponse) {
      await toCache.put(metaRequest, metaResponse.clone());

      const meta = await metaResponse
        .clone()
        .json()
        .catch(() => null);

      const indexKey = meta?.indexKey;
      if (typeof indexKey === 'string' && indexKey.length) {
        await copyCacheEntry({ fromCache, toCache, key: indexKey });
      }
    }
  }
}

async function copyCacheEntry({ fromCache, toCache, key }) {
  const request = normalizeCacheKey(key);
  const already = await toCache.match(request);
  if (already) return;

  const response = await fromCache.match(request);
  if (!response) return;

  await toCache.put(request, response.clone());
}

async function cacheGetJson(key = 'json', cacheName = CACHE_NAME) {
  // console.time(`${logPrefix} cacheGetJson`);
  const cache = await caches.open(cacheName);
  const response = await cache.match(normalizeCacheKey(key));
  const json = await response?.json();
  // console.timeEnd(`${logPrefix} cacheGetJson`);
  return json;
}

async function cacheGetText(key = 'text', cacheName = CACHE_NAME) {
  // console.time(`${logPrefix} cacheGetText`);
  const cache = await caches.open(cacheName);
  const response = await cache.match(normalizeCacheKey(key));
  const text = await response?.text();
  // console.timeEnd(`${logPrefix} cacheGetText`);
  return text;
}

async function cachePutJson(json, key = 'json', cacheName = CACHE_NAME) {
  // Avoid logging massive payloads (e.g., the MiniSearch index), which is slow and noisy.
  if (key === 'json') {
    console.debug(logPrefix, 'cachePutJson', {
      key,
      cacheName,
      type: Array.isArray(json) ? 'array' : typeof json,
      length: Array.isArray(json) ? json.length : undefined,
    });
  } else {
    console.debug(logPrefix, 'cachePutJson', { key, cacheName });
  }
  const cache = await caches.open(cacheName);
  const response = new Response(JSON.stringify(json));
  await cache.put(normalizeCacheKey(key), response);
}

async function cachePutText(text, key = 'text', cacheName = CACHE_NAME) {
  console.debug(logPrefix, 'cachePutText', { key, cacheName, size: text?.length });
  const cache = await caches.open(cacheName);
  const response = new Response(text, { headers: { 'content-type': 'application/json' } });
  await cache.put(normalizeCacheKey(key), response);
}

async function cachePutFile(file, key = 'file', cacheName = CACHE_NAME) {
  console.debug(logPrefix, 'cachePutFile', {
    key,
    cacheName,
    name: file?.name,
    size: file?.size,
    type: file?.type,
    lastModified: file?.lastModified,
  });
  const cache = await caches.open(cacheName);
  const response = new Response(file);
  await cache.put(normalizeCacheKey(key), response);
}

function normalizeCacheKey(key) {
  // Cache Storage keys must be valid Request/URL strings. Keys like `minisearch:index:...`
  // are interpreted as a URL with scheme `minisearch:` and will throw.
  if (key instanceof Request) return key;
  if (typeof key !== 'string') return key;

  // Allow normal/relative keys ('json', 'file') and full http(s) URLs.
  if (!key.includes(':')) return key;
  if (key.startsWith('http://') || key.startsWith('https://')) return key;

  // Encode custom scheme-ish keys into a safe same-origin URL path.
  const url = new URL(`/_cache/${encodeURIComponent(key)}`, window.location.origin);
  return new Request(url);
}

function getConversationsSignature(conversations) {
  if (!conversations?.length) return 'empty';
  // Order-independent signature so we don't miss cache hits if sort order changes.
  const parts = conversations
    .map(c => `${c.id}:${c.updated}`)
    .sort();
  return fnv1a(parts.join('|'));
}

function fnv1a(str) {
  // 32-bit FNV-1a
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Unsigned, compact string
  return (hash >>> 0).toString(16);
}

// Bump this when changing the MiniSearch persisted schema (e.g., storeFields).
const MINISEARCH_META_KEY = 'minisearch:index:meta:v2';
function getMiniSearchIndexKey(signature) {
  return `minisearch:index:${signature}:v2`;
}

async function restoreMiniSearchIndex({ signature, miniSearchOptions }) {
  if (!signature || signature === 'empty') return null;

  const expectedIndexKey = getMiniSearchIndexKey(signature);

  try {
    const meta = await cacheGetJson(MINISEARCH_META_KEY);
    if (meta?.signature === signature && meta?.indexKey === expectedIndexKey) {
      // minisearch@6 expects a JSON string here (it JSON.parse's internally).
      const jsonText = await cacheGetText(expectedIndexKey);
      if (jsonText) {
        console.debug(logPrefix, 'MiniSearch: restore hit', {
          signature,
          indexKey: expectedIndexKey,
          size: jsonText.length,
        });
        return MiniSearch.loadJSON(jsonText, miniSearchOptions);
      }
    }
  } catch (err) {
    console.warn(logPrefix, 'MiniSearch: failed to restore from Cache Storage', err);
  }

  return null;
}

async function persistMiniSearchIndex({ signature, miniSearchOptions, miniSearch }) {
  if (!signature || signature === 'empty' || !miniSearch) return;

  const indexKey = getMiniSearchIndexKey(signature);
  const meta = {
    signature,
    indexKey,
    createdAt: Date.now(),
    miniSearchOptions,
  };

  const indexJson = miniSearch.toJSON();
  let indexText = undefined;
  try {
    indexText = JSON.stringify(indexJson);
  } catch {
    console.warn(logPrefix, 'MiniSearch: failed to serialize index JSON', { signature });
    return;
  }

  try {
    // Store index as text so restore can pass it straight to MiniSearch.loadJSON.
    await cachePutText(indexText, indexKey);
    await cachePutJson(meta, MINISEARCH_META_KEY);
  } catch (err) {
    console.warn(logPrefix, 'MiniSearch: failed to persist to Cache Storage', err);
  }
}

async function processFile(file) {
  // console.time(`${logPrefix} processFile`);
  console.debug(logPrefix, 'processFile: start', {
    name: file?.name,
    size: file?.size,
    type: file?.type,
  });
  const buffer = await readFileFromInput(file);
  const zip = await JSZip.loadAsync(buffer);
  const text = await zip.file('conversations.json')?.async('text');
  const json = JSON.parse(text ?? '');
  const conversations = json.map(mapConversation).sort(sortConversation);
  console.debug(logPrefix, 'processFile: parsed conversations', {
    conversationsCount: conversations.length,
  });
  console.debug(logPrefix, 'processFile: conversations (debug dump)', conversations);
  console.log(`${logPrefix} ${conversations.length} conversations loaded`);
  // console.timeEnd(`${logPrefix} processFile`);
  return conversations;

  function mapConversation(conversation) {
    const messages = Object.values(conversation.mapping)
      .filter(m => m.message)
      .map(mapMessage);
    return {
      title: conversation.title,
      messages,
      time: conversation.create_time,
      id: conversation.conversation_id,
      updated: conversation.update_time,
      text: messages.map(m => `[${m.author}] ${m.text}`).join('\n'),
    };
  }

  function mapMessage({ message }) {
    const author = message.author.role;
    const text = message.content.parts?.join(' ');
    return {
      author,
      text,
    };
  }

  function sortConversation(a, b) {
    return a.create_time - b.create_time;
  }
}

/* Utils */

function readFileFromInput(file) {
  const reader = new FileReader();
  const contentsPromise = new Promise((resolve, reject) => {
    reader.onload = e => resolve(e.target?.result);
    reader.onerror = e => reject(e.target?.error);
  });
  reader.readAsArrayBuffer(file);
  return contentsPromise;
}

function downloadMarkdown(text, filename) {
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
