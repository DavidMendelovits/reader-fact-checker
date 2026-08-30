// Three states, one file: token gate → Reader library → the reader itself.
// The reader is deliberately sparse — the conversation is the interface; the
// screen mostly shows where the voice is in the text.
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, FlatList, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { useStore } from './src/store'
import { loadSettings, saveToken } from './src/settings'
import { listDocuments, fetchDocument } from './src/readwise'
import { htmlToParagraphs } from './src/html'
import { openingTurn, pause, play, setMicEnabled } from './src/agent'
import type { ReaderDoc } from './src/types'

const AGENT_LABEL: Record<string, string> = {
  idle: '', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking', reading: 'Reading',
}

export default function App() {
  const [token, setToken] = useState<string | null>(null)
  const [booted, setBooted] = useState(false)
  const doc = useStore((s) => s.doc)

  useEffect(() => {
    void loadSettings().then(({ token }) => {
      setToken(token)
      setBooted(true)
    })
  }, [])

  if (!booted) return <Centered><ActivityIndicator /></Centered>
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      {!token ? (
        <TokenScreen onSaved={setToken} />
      ) : !doc ? (
        <LibraryScreen token={token} onSignOut={() => setToken(null)} />
      ) : (
        <ReaderScreen />
      )}
      <Notice />
    </SafeAreaView>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={[styles.root, styles.centered]}>{children}</View>
}

function Notice() {
  const notice = useStore((s) => s.notice)
  if (!notice) return null
  return (
    <Pressable style={styles.notice} onPress={() => useStore.getState().setNotice(null)}>
      <Text style={styles.noticeText}>{notice}</Text>
    </Pressable>
  )
}

function TokenScreen({ onSaved }: { onSaved: (t: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <View style={styles.tokenScreen}>
      <Text style={styles.h1}>Reader, out loud</Text>
      <Text style={styles.body}>
        Paste your Readwise access token (readwise.io/access_token). It stays on this device.
      </Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={setValue}
        placeholder="Access token"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        style={[styles.button, !value.trim() && styles.buttonDisabled]}
        disabled={!value.trim()}
        onPress={() => {
          void saveToken(value)
          onSaved(value.trim())
        }}
      >
        <Text style={styles.buttonText}>Open my library</Text>
      </Pressable>
    </View>
  )
}

function LibraryScreen({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [docs, setDocs] = useState<ReaderDoc[] | null>(null)
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    listDocuments(token)
      .then(setDocs)
      .catch((e) => {
        useStore.getState().setNotice(String(e.message ?? e))
        setDocs([])
      })
  }, [token])

  const open = async (d: ReaderDoc) => {
    setOpening(d.id)
    try {
      const full = await fetchDocument(token, d.id)
      const paragraphs = htmlToParagraphs(full.html_content ?? '')
      if (paragraphs.length === 0) throw new Error('This document has no readable text.')
      useStore.getState().setDoc({
        id: d.id,
        title: d.title ?? 'Untitled',
        source: d.source_url ?? 'Readwise Reader',
        chapters: [{ title: d.title ?? 'Untitled', paragraphs }],
      })
      // Voice-first: opening a document hands the floor to the agent.
      setMicEnabled(true)
      openingTurn()
    } catch (e) {
      useStore.getState().setNotice(String((e as Error).message ?? e))
    } finally {
      setOpening(null)
    }
  }

  if (!docs) return <Centered><ActivityIndicator /></Centered>
  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <Text style={styles.h1}>Reader</Text>
        <Pressable onPress={onSignOut}><Text style={styles.link}>token</Text></Pressable>
      </View>
      <FlatList
        data={docs}
        keyExtractor={(d) => d.id}
        renderItem={({ item }) => (
          <Pressable style={styles.docRow} onPress={() => void open(item)}>
            <View style={styles.flex}>
              <Text style={styles.docTitle} numberOfLines={2}>{item.title ?? 'Untitled'}</Text>
              <Text style={styles.docMeta} numberOfLines={1}>
                {[item.author, item.word_count ? `${Math.round(item.word_count / 200)} min` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            {opening === item.id && <ActivityIndicator />}
          </Pressable>
        )}
        ListEmptyComponent={<Text style={[styles.body, styles.padded]}>Nothing in your Reader library.</Text>}
      />
    </View>
  )
}

function ReaderScreen() {
  const doc = useStore((s) => s.doc)
  const paragraphs = useStore((s) => s.paragraphs)
  const current = useStore((s) => s.currentParagraph)
  const playing = useStore((s) => s.playing)
  const rate = useStore((s) => s.rate)
  const micEnabled = useStore((s) => s.micEnabled)
  const agentState = useStore((s) => s.agentState)
  const chat = useStore((s) => s.chat)
  const list = useRef<FlatList>(null)

  useEffect(() => {
    if (paragraphs.length === 0) return
    list.current?.scrollToIndex({ index: current, viewPosition: 0.3, animated: true })
  }, [current, paragraphs.length])

  const lastLine = chat[chat.length - 1]

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            pause()
            setMicEnabled(false)
            useStore.getState().clearDoc()
          }}
        >
          <Text style={styles.link}>‹ Library</Text>
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{doc?.title}</Text>
        <Pressable onPress={() => (playing ? pause() : play())}>
          <Text style={styles.link}>{playing ? 'Pause' : 'Play'}</Text>
        </Pressable>
      </View>
      <FlatList
        ref={list}
        data={paragraphs}
        keyExtractor={(_, i) => String(i)}
        onScrollToIndexFailed={() => {}}
        renderItem={({ item, index }) => (
          <Text style={[styles.paragraph, index === current && styles.currentParagraph]}>
            {item.text}
          </Text>
        )}
      />
      <View style={styles.footer}>
        {lastLine && (
          <Text style={styles.chatLine} numberOfLines={2}>
            {lastLine.role === 'user' ? 'You: ' : ''}{lastLine.text}
          </Text>
        )}
        <View style={styles.footerRow}>
          <Pressable onPress={() => setMicEnabled(!micEnabled)}>
            <Text style={[styles.mic, micEnabled && styles.micOn]}>{micEnabled ? '● mic on' : '○ mic off'}</Text>
          </Pressable>
          <Text style={styles.agentState}>{AGENT_LABEL[agentState]}</Text>
          <Text style={styles.docMeta}>{rate}x · ¶{current + 1}/{paragraphs.length}</Text>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#faf8f4' },
  flex: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  padded: { padding: 20 },
  h1: { fontSize: 24, fontWeight: '700', color: '#1a1712' },
  body: { fontSize: 15, color: '#5a544a', lineHeight: 22 },
  link: { fontSize: 15, color: '#8a5a2b', fontWeight: '600' },
  tokenScreen: { padding: 24, gap: 14, justifyContent: 'center', flex: 1 },
  input: {
    borderWidth: 1, borderColor: '#d8d2c6', borderRadius: 8, padding: 12,
    fontSize: 15, backgroundColor: '#fff',
  },
  button: { backgroundColor: '#1a1712', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#faf8f4', fontSize: 15, fontWeight: '600' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, gap: 12,
    borderBottomWidth: 1, borderBottomColor: '#e8e2d6',
  },
  headerTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: '#1a1712', textAlign: 'center' },
  docRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#efe9df',
  },
  docTitle: { fontSize: 16, color: '#1a1712', fontWeight: '500' },
  docMeta: { fontSize: 13, color: '#8d867a', marginTop: 2 },
  paragraph: { fontSize: 17, lineHeight: 27, color: '#3c372e', paddingHorizontal: 20, paddingVertical: 8 },
  currentParagraph: { backgroundColor: '#f3ead8', color: '#1a1712' },
  footer: { borderTopWidth: 1, borderTopColor: '#e8e2d6', padding: 12, gap: 8, backgroundColor: '#faf8f4' },
  chatLine: { fontSize: 14, color: '#5a544a', fontStyle: 'italic' },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mic: { fontSize: 14, color: '#8d867a', fontWeight: '600' },
  micOn: { color: '#2b6a3f' },
  agentState: { fontSize: 13, color: '#8a5a2b' },
  notice: {
    position: 'absolute', bottom: 90, left: 16, right: 16, backgroundColor: '#1a1712',
    borderRadius: 10, padding: 12,
  },
  noticeText: { color: '#faf8f4', fontSize: 14 },
})
