// AsyncStorage as the KeyValueStore port. The only file that imports it for data.
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { KeyValueStore } from './ports'

export const asyncStore: KeyValueStore = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
}
