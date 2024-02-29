import React, { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import MiniSearch from 'minisearch';
import Markdown from 'react-markdown';
import ReadMe from '../README.md?raw';

// console.log('ReadMe:', ReadMe);

let didInit = false;
const root = createRoot(document.getElementById('app') || document.body);
root.render(<App />);

/* Components */

function App() {
  const [conversations, setConversations] = useState([]);
  // console.log('conversations.length:', conversations.length)
  const [input, setInput] = useState('');

  useEffect(() => {
    if (!didInit) {
      didInit = true;
      // cacheGetFile('conversations', 'myCache').then(processFile).then(setConversations);
      cacheGetJson('json', 'myCache').then((c) => setConversations(c || []));
    }
  });

  return (
    <>
      <h1>ChatGPT Search</h1>
      {!conversations.length && (
        // <Markdown>{ReadMe}</Markdown>
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
        <input type="text" autoFocus onChange={onType} />
      )}
      {/* <SearchResults input={input} conversations={conversations} /> */}
      {!!conversations?.length && (
        <SearchResults input={input} conversations={conversations} />
      )}
      {/* {!!input && <SearchResults input={input} conversations={conversations} />} */}
      <input type="file" onChange={onFile} />
      {!conversations.length && <Markdown>{ReadMe}</Markdown>}
    </>
  );

  async function onType(e) {
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

function SearchResults({ input, conversations }) {
  const miniSearch = useMemo(memo, [conversations]);
  const showing = miniSearch.search(input) ?? [];

  return (
    <>
      <p className="search-results">
        Showing {showing.length} of {conversations?.length ?? 0} conversations
      </p>
      <ol className="search-results">
        {showing.map((c) => (
          <li>{map(c)}</li>
        ))}
      </ol>
    </>
  );

  function map(c) {
    return <a href={`https://chat.openai.com/c/${c.id}`}>{c.title}</a>;
  }

  function memo() {
    console.time('miniSearch');
    let miniSearch;
    setTimeout(() => {
      miniSearch = new MiniSearch({
        fields: ['title', 'text'],
        storeFields: ['id', 'title', 'date'],
      });
      miniSearch.addAll(conversations);
      console.timeEnd('miniSearch');
      return miniSearch;
    });
    return { search: (i) => miniSearch?.search?.(i) };
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
  const json = response?.json();
  // const blob = await response?.blob();
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
