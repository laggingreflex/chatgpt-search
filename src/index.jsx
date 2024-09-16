import React, { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import MiniSearch from 'minisearch';
import Markdown from 'react-markdown';
import ReadMe from '../README.md?raw';

let didInit = false;
const root = createRoot(document.getElementById('app') || document.body);
root.render(<App />);

/* Components */

function App() {
  const [conversations, setConversations] = useState([]);
  const [input, setInput] = useState('');
  const [fuzzy, setFuzzy] = useState(true); // State for fuzzy search toggle

  useEffect(() => {
    if (!didInit) {
      didInit = true;
      cacheGetJson('json', 'myCache').then((c) => setConversations(c || []));
    }
  }, []);

  return (
    <div
      className={['app', conversations.length ? 'loaded' : 'loading']
        .filter(Boolean)
        .join(' ')}
    >
      <h1>ChatGPT Search</h1>
      {!conversations.length && (
        <p>
          Goto{' '}
          <a href="https://chat.openai.com/#settings/DataControls">
            ChatGPT » Export data
          </a>{' '}
          and upload (the zip file) here, then you can search through all your
          conversations.
        </p>
      )}
      {!!conversations?.length && (
        <>
          <input
            name="search"
            type="text"
            autoFocus
            onChange={onType}
            placeholder="Search conversations..."
          />
          <label>
            <input
              type="checkbox"
              checked={fuzzy}
              onChange={(e) => setFuzzy(e.target.checked)}
            />{' '}
            Fuzzy Search
          </label>
          <SearchResults input={input} conversations={conversations} fuzzy={fuzzy} />
        </>
      )}
      <label className="input file">
        Upload your ChatGPT data
        <input name="file" type="file" onChange={onFile} accept=".zip" />
      </label>
      {!conversations.length && <Markdown>{ReadMe}</Markdown>}
    </div>
  );

  function onType(e) {
    const text = e.target.value;
    setInput(text);
  }

  async function onFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const conversations = await processFile(file);
    setConversations(conversations);
    await cachePutFile(file, 'file', 'myCache');
    await cachePutJson(conversations, 'json', 'myCache');
  }
}

function SearchResults({ input, conversations, fuzzy }) {
  const miniSearch = useMemo(() => {
    console.time('miniSearch');
    let miniSearch = new MiniSearch({
      fields: ['title', 'text'],
      storeFields: ['id', 'title', 'updated'],
      searchOptions: {
        boost: { title: 2 },
      },
      // Ensure case-insensitive search (default behavior)
      tokenize: (string, _fieldName) => string.toLowerCase().split(/\s+/),
    });
    miniSearch.addAll(conversations);
    console.timeEnd('miniSearch');
    return miniSearch;
  }, [conversations]);

  const options = fuzzy
    ? {}
    : { prefix: false, fuzzy: false };

  const showing = input
    ? miniSearch.search(input.trim(), options) ?? []
    : [];

  // Sort results by date (newest first)
  showing.sort((a, b) => b.updated - a.updated);

  return (
    <>
      <p className="search-results">
        Showing {showing.length} of {conversations?.length ?? 0} conversations
      </p>
      <ol className="search-results">
        {showing.map((c) => (
          <li key={c.id}>{map(c)}</li>
        ))}
      </ol>
    </>
  );

  function map(c) {
    const date = new Date(c.updated * 1000).toLocaleString();
    return (
      <>
        <a href={`https://chat.openai.com/c/${c.id}`}>{c.title}</a>{' '}
        <span>({date})</span>
      </>
    );
  }
}

/* Helpers */

async function cacheGetFile(key = 'file', cacheName = 'myCache') {
  console.time('cacheGetFile');
  const cache = await caches.open(cacheName);
  const response = await cache.match(key);
  const blob = await response?.blob();
  console.timeEnd('cacheGetFile');
  return blob;
}

async function cacheGetJson(key = 'json', cacheName = 'myCache') {
  console.time('cacheGetJson');
  const cache = await caches.open(cacheName);
  const response = await cache.match(key);
  const json = await response?.json();
  console.timeEnd('cacheGetJson');
  return json;
}

async function cachePutJson(json, key = 'json', cacheName = 'myCache') {
  console.log('json:', json);
  const cache = await caches.open(cacheName);
  const response = new Response(JSON.stringify(json));
  await cache.put(key, response);
}

async function cachePutFile(file, key = 'file', cacheName = 'myCache') {
  console.log('file:', file);
  const cache = await caches.open(cacheName);
  const response = new Response(file);
  await cache.put(key, response);
}

async function processFile(file) {
  console.time('processFile');
  const buffer = await readFileFromInput(file);
  const zip = await JSZip.loadAsync(buffer);
  const text = await zip.file('conversations.json')?.async('text');
  const json = JSON.parse(text ?? '');
  const conversations = json.map(mapConversation).sort(sortConversation);
  console.debug(conversations);
  console.log(`${conversations.length} conversations loaded`);
  console.timeEnd('processFile');
  return conversations;

  function mapConversation(conversation) {
    const messages = Object.values(conversation.mapping)
      .filter((m) => m.message)
      .map(mapMessage);
    return {
      title: conversation.title,
      messages,
      time: conversation.create_time,
      id: conversation.conversation_id,
      updated: conversation.update_time,
      text: messages.map((m) => `[${m.author}] ${m.text}`).join('\n'),
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
    reader.onload = (e) => resolve(e.target?.result);
    reader.onerror = (e) => reject(e.target?.error);
  });
  reader.readAsArrayBuffer(file);
  return contentsPromise;
}
