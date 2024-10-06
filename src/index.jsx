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
  const [selectedConversations, setSelectedConversations] = useState(new Set());
  const [input, setInput] = useState('');
  const [fuzzy, setFuzzy] = useState(true); // State for fuzzy search toggle
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState({
    mergeDownload: false,
    keepFilteredSelected: false,
  });
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (!didInit) {
      didInit = true;
      setLoading(true);
      cacheGetJson('json', 'myCache')
        .then((c) => setConversations(c || []))
        .finally(() => setLoading(false));
    }
  });

  const toggleSelectConversation = (conversationId) => {
    setSelectedConversations((prevSelected) => {
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
    const selected = conversations.filter((c) => selectedConversations.has(c.id));
    if (selected.length > 0) {
      if (settings.mergeDownload) {
        const combinedText = selected.map((c) => `# ${c.title}\n\n${c.text}`).join('\n\n---\n\n');
        downloadMarkdown(combinedText, 'selected_conversations.md');
      } else {
        const zip = new JSZip();
        selected.forEach((c) => {
          zip.file(`${c.title}.md`, c.text);
        });
        zip.generateAsync({ type: 'blob' }).then((content) => {
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

  return (
    <div
      className={['app', conversations.length ? 'loaded' : 'loading']
        .filter(Boolean)
        .join(' ')}
    >
      <h1>ChatGPT Search</h1>
      <button className="settings-button" onClick={() => setShowSettings(!showSettings)}>
        ⚙️
      </button>
      {showSettings && (
        <div className="settings-popup">
          <h2>Settings</h2>
          <label>
            <input
              type="checkbox"
              checked={settings.mergeDownload}
              onChange={(e) => setSettings((prev) => ({ ...prev, mergeDownload: e.target.checked }))}
            />{' '}
            Merge downloads as a single Markdown file
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.keepFilteredSelected}
              onChange={(e) => setSettings((prev) => ({ ...prev, keepFilteredSelected: e.target.checked }))}
            />{' '}
            Keep filtered items selected
          </label>
        </div>
      )}
      {loading && <pre className='loading'> Loading your saved conversations.. </pre>}
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
          <input name="search" type="text" autoFocus onChange={onType} />
          <label>
            <input
              type="checkbox"
              checked={fuzzy}
              onChange={(e) => setFuzzy(e.target.checked)}
            />{' '}
            Fuzzy Search
          </label>
          <SearchResults
            input={input}
            conversations={conversations}
            fuzzy={fuzzy}
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
      <label className="input file">
        Upload your ChatGPT data
        <input name="file" type="file" onChange={onFile} accept=".zip" />
      </label>
      {!conversations.length && <Markdown>{ReadMe}</Markdown>}
    </div>
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

function SearchResults({
  input,
  conversations,
  fuzzy,
  toggleSelectConversation,
  selectedConversations,
  setSelectedConversations,
  settings
}) {
  useEffect(() => {
    if (!settings.keepFilteredSelected) {
      setSelectedConversations((prevSelected) => {
        const updatedSelected = new Set(
          Array.from(prevSelected).filter((id) => conversations.some((c) => c.id === id))
        );
        return updatedSelected;
      });
    }
  }, [settings.keepFilteredSelected, conversations]);
  const miniSearch = useMemo(() => {
    console.time('miniSearch');
    let miniSearch = new MiniSearch({
      fields: ['title', 'text'],
      storeFields: ['id', 'title', 'updated'],
    });
    miniSearch.addAll(conversations);
    console.timeEnd('miniSearch');
    return miniSearch;
  }, [conversations]);

  let showing = [];

  if (input.trim()) {
    if (fuzzy) {
      const options = {}; // Default options for fuzzy search
      showing = miniSearch.search(input.trim(), options) ?? [];
    } else {
      // Exact match search (case-insensitive)
      const lowerInput = input.toLowerCase();
      showing = conversations.filter(
        (c) =>
          c.text.toLowerCase().includes(lowerInput) ||
          c.title.toLowerCase().includes(lowerInput)
      );
    }

    // Sort results by date (newest first)
    showing.sort((a, b) => b.updated - a.updated);
  }


  return (
    <>
      <p className="search-results">
        Showing {showing.length} of {conversations?.length ?? 0} conversations
      </p>
      <ol className="search-results">
        {showing.map((c) => (
          <li key={c.id}>
            {map(c)}
          </li>
        ))}
      </ol>
    </>
  );

  function map(c) {
    const date = new Date(c.updated * 1000).toLocaleString();
    const con = conversations.find((con) => con.id === c.id);
    return (
      <>
        <input
          type="checkbox"
          checked={selectedConversations.has(c.id)}
          onChange={() => toggleSelectConversation(c.id)}
        />
        <a href={`https://chat.openai.com/c/${c.id}`}>{c.title}</a>{' '}
        <span>({date})</span>
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