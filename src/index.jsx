import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import MiniSearch from 'minisearch';
import Markdown from 'react-markdown';
import ReadMe from '../README.md?raw';

const logPrefix = '[chatgpt-search]';

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
  });
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (!didInit) {
      didInit = true;
      setLoading(true);
      console.debug(logPrefix, 'init: restoring cached conversations');
      cacheGetJson('json', 'myCache')
        .then(c => {
          console.debug(logPrefix, 'init: cached conversations restored', {
            count: Array.isArray(c) ? c.length : undefined,
          });
          setConversations(c || []);
        })
        .finally(() => setLoading(false));
    }
  });

  useEffect(() => {
    let cancelled = false;

    const miniSearchOptions = {
      fields: ['title', 'text'],
      storeFields: ['id', 'title', 'updated'],
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
      await cachePutFile(file, 'file', 'myCache');
      await cachePutJson(conversations, 'json', 'myCache');
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

    // Sort results by date (newest first)
    showing.sort((a, b) => b.updated - a.updated);
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
}

/* Helpers */

async function cacheGetFile(key = 'file', cacheName = 'myCache') {
  // console.time(`${logPrefix} cacheGetFile`);
  const cache = await caches.open(cacheName);
  const response = await cache.match(normalizeCacheKey(key));
  const blob = await response?.blob();
  // console.timeEnd(`${logPrefix} cacheGetFile`);
  return blob;
}

async function cacheGetJson(key = 'json', cacheName = 'myCache') {
  // console.time(`${logPrefix} cacheGetJson`);
  const cache = await caches.open(cacheName);
  const response = await cache.match(normalizeCacheKey(key));
  const json = await response?.json();
  // console.timeEnd(`${logPrefix} cacheGetJson`);
  return json;
}

async function cacheGetText(key = 'text', cacheName = 'myCache') {
  // console.time(`${logPrefix} cacheGetText`);
  const cache = await caches.open(cacheName);
  const response = await cache.match(normalizeCacheKey(key));
  const text = await response?.text();
  // console.timeEnd(`${logPrefix} cacheGetText`);
  return text;
}

async function cachePutJson(json, key = 'json', cacheName = 'myCache') {
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

async function cachePutText(text, key = 'text', cacheName = 'myCache') {
  console.debug(logPrefix, 'cachePutText', { key, cacheName, size: text?.length });
  const cache = await caches.open(cacheName);
  const response = new Response(text, { headers: { 'content-type': 'application/json' } });
  await cache.put(normalizeCacheKey(key), response);
}

async function cachePutFile(file, key = 'file', cacheName = 'myCache') {
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

const MINISEARCH_META_KEY = 'minisearch:index:meta:v1';
function getMiniSearchIndexKey(signature) {
  return `minisearch:index:${signature}:v1`;
}

async function restoreMiniSearchIndex({ signature, miniSearchOptions }) {
  if (!signature || signature === 'empty') return null;

  const expectedIndexKey = getMiniSearchIndexKey(signature);

  try {
    const meta = await cacheGetJson(MINISEARCH_META_KEY, 'myCache');
    if (meta?.signature === signature && meta?.indexKey === expectedIndexKey) {
      // minisearch@6 expects a JSON string here (it JSON.parse's internally).
      const jsonText = await cacheGetText(expectedIndexKey, 'myCache');
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
    await cachePutText(indexText, indexKey, 'myCache');
    await cachePutJson(meta, MINISEARCH_META_KEY, 'myCache');
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
