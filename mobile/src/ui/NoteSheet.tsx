// A note on a highlight. It used to be a card centred in a Modal, which on a
// small phone put Save under the keyboard (K2); now it is a sheet that sits on
// top of the keyboard, so the field and both buttons are always visible.
import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { setHighlightNote } from '../session'
import { useStore } from '../store'
import { radius, size, space, useTheme, weight, type as type_, type Theme } from '../theme'
import type { Highlight } from '../types'
import { errorText } from './kit'
import { COLUMN_MAX_WIDTH } from './layout'

export function NoteSheet({ highlight, onClose }: { highlight: Highlight; onClose: () => void }) {
  const theme = useTheme()
  const s = styles(theme)
  const insets = useSafeAreaInsets()
  const [text, setText] = useState(highlight.note ?? '')

  const save = () => {
    void setHighlightNote(highlight.id, text).catch((e: unknown) => useStore.getState().setNotice(errorText(e)))
    onClose()
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={s.fill}>
        <Pressable style={s.backdrop} accessibilityLabel="Close" onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
          <Text style={s.title} accessibilityRole="header">{highlight.note ? 'Edit note' : 'Add a note'}</Text>
          <Text style={s.quote} numberOfLines={3}>“{highlight.text}”</Text>
          <TextInput
            style={s.input}
            value={text}
            onChangeText={setText}
            placeholder="Your note"
            placeholderTextColor={theme.textTertiary}
            multiline
            autoFocus
            accessibilityLabel="Your note"
          />
          <View style={s.actions}>
            <Pressable role="button" accessibilityLabel="Cancel" style={s.cancel} onPress={onClose}>
              <Text style={s.link}>Cancel</Text>
            </Pressable>
            <Pressable role="button" accessibilityLabel="Save" style={s.button} onPress={save}>
              <Text style={s.buttonText}>Save</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const cache = new WeakMap<Theme, ReturnType<typeof build>>()
function styles(theme: Theme) {
  let s = cache.get(theme)
  if (!s) {
    s = build(theme)
    cache.set(theme, s)
  }
  return s
}

function build(theme: Theme) {
  return StyleSheet.create({
    fill: { flex: 1 },
    backdrop: { flex: 1 },
    sheet: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: radius.card,
      borderTopRightRadius: radius.card,
      paddingHorizontal: space.lg,
      paddingTop: space.lg,
      gap: space.md,
      width: '100%',
      maxWidth: COLUMN_MAX_WIDTH,
      alignSelf: 'center',
    },
    title: { ...type_.ui, fontWeight: weight.semibold, color: theme.textPrimary },
    quote: { ...type_.meta, color: theme.textSecondary, fontStyle: 'italic' },
    input: {
      minHeight: 80, textAlignVertical: 'top',
      borderWidth: 1, borderColor: theme.hairline, borderRadius: radius.input,
      padding: space.md, ...type_.input, color: theme.textPrimary,
      backgroundColor: theme.surfaceSecondary,
    },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: space.lg },
    cancel: { minHeight: size.target, justifyContent: 'center', paddingHorizontal: space.sm },
    link: { ...type_.ui, color: theme.accent, fontWeight: weight.semibold },
    button: {
      minHeight: size.target, justifyContent: 'center', paddingHorizontal: space.xl,
      backgroundColor: theme.textPrimary, borderRadius: radius.input,
    },
    buttonText: { ...type_.ui, color: theme.canvas, fontWeight: weight.semibold },
  })
}
