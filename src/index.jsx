import React, { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import MiniSearch from 'minisearch';

let didInit = false;
const root = createRoot(document.getElementById('app') || document.body);
root.render(<App />);

/* Components */

function App() {
  const [conversations, setConversations] = useState([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    if (!didInit) {
      didInit = true;
      cacheGet('file', 'myCache').then(processFile).then(setConversations);
    }
  });

  return (
    <>
      <h1>OpenAI Chat Search</h1>
      <input type="text" onChange={onType} />
      <SearchResults input={input} conversations={conversations} />
      <input type="file" onChange={onFile} />
      {!conversations.length && (
        <>
          <h1>How</h1>
          <p>
            Goto{' '}
            <a href="https://chat.openai.com/#settings/DataControls">
              ChatGPT » Export data
            </a>{' '}
            and upload here, then you can search through all your conversations.
          </p>
        </>
      )}
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
    await cachePut(file, 'file', 'myCache');
  }
}

function SearchResults({ input, conversations }) {
  const miniSearch = useMemo(memo, [conversations]);
  const showing = miniSearch.search(input);

  return (
    <>
      <ol>
        {showing.map((c) => (
          <li>{map(c)}</li>
        ))}
      </ol>
      <p>
        Showing {showing.length} of {conversations?.length ?? 0} conversations
      </p>
    </>
  );

  function map(c) {
    return <a href={`https://chat.openai.com/c/${c.id}`}>{c.title}</a>;
  }

  function memo() {
    const miniSearch = new MiniSearch({
      fields: ['title', 'text'],
      storeFields: ['id', 'title', 'date'],
    });
    miniSearch.addAll(conversations);
    return miniSearch;
  }
}

/* Helpers */

async function cacheGet(key = 'file', cacheName = 'myCache') {
  const cache = await caches.open(cacheName);
  const response = await cache.match(key);
  const blob = await response?.blob();
  return blob;
}

async function cachePut(file, key = 'file', cacheName = 'myCache') {
  console.log('file:', file)
  const cache = await caches.open(cacheName);
  const response = new Response(file);
  await cache.put(key, response);
}

async function processFile(file) {
  const buffer = await readFileFromInput(file);
  const zip = await JSZip.loadAsync(buffer);
  const text = await zip.file('conversations.json')?.async('text');
  const json = JSON.parse(text ?? '');
  const conversations = json.map(mapConversation).sort(sortConversation);
  console.debug(conversations);
  console.log(`${conversations.length} conversations loaded`);
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
