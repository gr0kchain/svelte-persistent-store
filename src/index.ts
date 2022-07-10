import { get as getCookie, set as setCookie, erase as removeCookie } from "browser-cookies"
import ESSerializer from "esserializer"
import { get, set, createStore, del } from "idb-keyval"
import type { Writable } from "svelte/store"

/**
 * Disabled warnings about missing/unavailable storages
 */
export function disableWarnings(): void { noWarnings = true }
/**
 * If set to true, no warning will be emitted if the requested Storage is not found.
 * This option can be useful when the lib is used on a server.
 */
let noWarnings = false
/**
 * List of storages where the warning have already been displayed.
 */
const alreadyWarnFor:Array<string> = []

/**
 * Add a log to indicate that the requested Storage have not been found.
 * @param {string} storageName
 */
const warnStorageNotFound = (storageName) => {
    const isProduction = (typeof process !== "undefined" && process.env?.NODE_ENV === "production")

    if (!noWarnings && alreadyWarnFor.indexOf(storageName) === -1 && !isProduction) {
        let message = `Unable to find the ${storageName}. No data will be persisted.`
        if (typeof window === "undefined") {
            message += "\n" + "Are you running on a server? Most of storages are not available while running on a server."
        }
        console.warn(message)
        alreadyWarnFor.push(storageName)
    }
}

const allowedClasses = []
/**
 * Add a class to the allowed list of classes to be serialized
 * @param classDef The class to add to the list
 */
export const addSerializableClass = (classDef: () => unknown): void => { allowedClasses.push(classDef) }

const serialize = (value: unknown): string => ESSerializer.serialize(value)
const deserialize = (value: string): unknown => {
    // @TODO: to remove in the next major
    if (value === "undefined") {
        return undefined
    }

    if (value !== null && value !== undefined) {
        try {
            return ESSerializer.deserialize(value, allowedClasses)
        } catch (e) {
            // Do nothing
            // use the value "as is"
        }
        try {
            return JSON.parse(value)
        } catch (e) {
            // Do nothing
            // use the value "as is"
        }
    }
    return value
}

/**
 * A store that keep it's value in time.
 */
export interface PersistentStore<T> extends Writable<T> {
    /**
     * Delete the store value from the persistent storage
     */
    delete(): void
}

/**
 * Storage interface
 */
export interface StorageInterface<T> {
    /**
     * Get a value from the storage.
     *
     * If the value doesn't exists in the storage, `null` should be returned.
     * This method MUST be synchronous.
     * @param key The key/name of the value to retrieve
     */
    getValue(key: string): T | null,

    /**
     * Save a value in the storage.
     * @param key The key/name of the value to save
     * @param value The value to save
     */
    setValue(key: string, value: T): void,

    /**
     * Remove a value from the storage
     * @param key The key/name of the value to remove
     */
    deleteValue(key: string): void
}

export interface SelfUpdateStorageInterface<T> extends StorageInterface<T> {
    /**
     * Add a listener to the storage values changes
     * @param {string} key The key to listen
     * @param {(newValue: T) => void} listener The listener callback function
     */
    addListener(key: string, listener: (newValue: T) => void): void;
    /**
     * Remove a listener from the storage values changes
     * @param {string} key The key that was listened
     * @param {(newValue: T) => void} listener The listener callback function to remove
     */
    removeListener(key: string, listener: (newValue: T) => void): void;
}

/**
 * Make a store persistent
 * @param {Writable<*>} store The store to enhance
 * @param {StorageInterface} storage The storage to use
 * @param {string} key The name of the data key
 */
export function persist<T>(store: Writable<T>, storage: StorageInterface<T>, key: string): PersistentStore<T> {
    const initialValue = storage.getValue(key)

    if (null !== initialValue) {
        store.set(initialValue)
    }

    if ((storage as SelfUpdateStorageInterface<T>).addListener) {
        (storage as SelfUpdateStorageInterface<T>).addListener(key, newValue => {
            store.set(newValue)
        })
    }

    store.subscribe(value => {
        storage.setValue(key, value)
    })

    return {
        ...store,
        delete() {
            storage.deleteValue(key)
        }
    }
}

const sharedCookieStorage = createCookieStorage(),
    sharedLocalStorage:StorageInterface<any> = createLocalStorage(),
    sharedSessionStorage:StorageInterface<any> = createSessionStorage()
/**
 * Persist a store into a cookie
 * @param {Writable<*>} store The store to enhance
 * @param {string} cookieName The name of the cookie
 */
export function persistCookie<T>(store: Writable<T>, cookieName: string): PersistentStore<T> {
    return persist(store, sharedCookieStorage, cookieName)
}
/**
 * Persist a store into the browser session storage
 * @param {Writable<*>} store The store to enhance
 * @param {string} key The name of the key in the browser session storage
 */
export function persistBrowserSession<T>(store: Writable<T>, key: string): PersistentStore<T> {
    return persist(store, sharedSessionStorage, key)
}
/**
 * Persist a store into the browser local storage
 * @param {Writable<*>} store The store to enhance
 * @param {string} key The name of the key in the browser local storage
 */
export function persistBrowserLocal<T>(store: Writable<T>, key: string): PersistentStore<T> {
    return persist(store, sharedLocalStorage, key)
}

function getBrowserStorage(browserStorage: Storage, listenExternalChanges = false): SelfUpdateStorageInterface<any> {
    const listeners: Array<{key: string, listener: (newValue: any) => void}> = []
    const listenerFunction = (event: StorageEvent) => {
        const eventKey = event.key
        if (event.storageArea === browserStorage) {
            listeners
                .filter(({key}) => key === eventKey)
                .forEach(({listener}) => {
                    listener(deserialize(event.newValue))
                })
        }
    }
    const connect = () => {
        if (listenExternalChanges && typeof window !== "undefined" && window?.addEventListener) {
            window.addEventListener("storage", listenerFunction)
        }
    }
    const disconnect = () => {
        if (listenExternalChanges && typeof window !== "undefined" && window?.removeEventListener) {
            window.removeEventListener("storage", listenerFunction)
        }
    }

    return {
        addListener(key: string, listener: (newValue: any) => void) {
            listeners.push({key, listener})
            if (listeners.length === 1) {
                connect()
            }
        },
        removeListener(key: string, listener: (newValue: any) => void) {
            const index = listeners.indexOf({key, listener})
            if (index !== -1) {
                listeners.splice(index, 1)
            }
            if (listeners.length === 0) {
                disconnect()
            }
        },
        getValue(key: string): any | null {
            const value = browserStorage.getItem(key)
            return deserialize(value)
        },
        deleteValue(key: string) {
            browserStorage.removeItem(key)
        },
        setValue(key: string, value: any) {
            browserStorage.setItem(key, serialize(value))
        }
    }
}

/**
 * Storage implementation that use the browser local storage
 * @param {boolean} listenExternalChanges - Update the store if the localStorage is updated from another page
 */
export function createLocalStorage<T>(listenExternalChanges = false): StorageInterface<T> {
    if (typeof window !== "undefined" && window?.localStorage) {
        return getBrowserStorage(window.localStorage, listenExternalChanges)
    }
    warnStorageNotFound("window.localStorage")
    return createNoopStorage()
}

/**
 * Storage implementation that use the browser session storage
 * @param {boolean} listenExternalChanges - Update the store if the sessionStorage is updated from another page
 */
export function createSessionStorage<T>(listenExternalChanges = false): StorageInterface<T> {
    if (typeof window !== "undefined" && window?.sessionStorage) {
        return getBrowserStorage(window.sessionStorage, listenExternalChanges)
    }
    warnStorageNotFound("window.sessionStorage")
    return createNoopStorage()
}

/**
 * Storage implementation that use the browser cookies
 */
export function createCookieStorage(): StorageInterface<any> {
    if (typeof document === "undefined" || typeof document?.cookie !== "string") {
        warnStorageNotFound("document.cookies")
        return createNoopStorage()
    }

    return {
        getValue(key: string): any | null {
            const value = getCookie(key)
            return deserialize(value)
        },
        deleteValue(key: string) {
            removeCookie(key, { samesite: "Strict" })
        },
        setValue(key: string, value: any) {
            setCookie(key,
                serialize(value),
                { samesite: "Strict" }
            )
        }
    }
}

/**
 * Storage implementation that use the browser IndexedDB
 */
export function createIndexedDBStorage<T>(): SelfUpdateStorageInterface<T> {
    if (typeof indexedDB !== "object" || typeof window === "undefined" || typeof window?.indexedDB !== "object") {
        warnStorageNotFound("IndexedDB")
        return createNoopSelfUpdateStorage()
    }

    const database = createStore("svelte-persist", "persist")
    const listeners: Array<{key: string, listener: (newValue: T) => void}> = []
    const listenerFunction = (eventKey: string, newValue: T) => {
        if (newValue === undefined) {
            return
        }
        listeners
            .filter(({key}) => key === eventKey)
            .forEach(({listener}) => listener(newValue))
    }
    return {
        addListener(key: string, listener: (newValue: any) => void) {
            listeners.push({key, listener})
        },
        removeListener(key: string, listener: (newValue: any) => void) {
            const index = listeners.indexOf({key, listener})
            if (index !== -1) {
                listeners.splice(index, 1)
            }
        },
        getValue(key: string): T | null {
            get(key, database).then(value => listenerFunction(key, (deserialize(value) as T)))
            return null
        },
        setValue(key: string, value: T): void {
            set(key, serialize(value), database)
        },
        deleteValue(key: string): void {
            del(key, database)
        }
    }
}

/**
 * Storage implementation that do nothing
 */
export function createNoopStorage(): StorageInterface<any> {
    return {
        getValue(): null {
            return null
        },
        deleteValue() {
            // Do nothing
        },
        setValue() {
            // Do nothing
        }
    }
}

function createNoopSelfUpdateStorage(): SelfUpdateStorageInterface<any> {
    return {
        addListener() {
            // Do nothing
        },
        removeListener() {
            // Do nothing
        },
        getValue(): null {
            return null
        },
        deleteValue() {
            // Do nothing
        },
        setValue() {
            // Do nothing
        }
    }
}

export {
    // @deprecate
    createNoopStorage as noopStorage,
    // @deprecate
    createLocalStorage as localStorage,
    // @deprecate
    createSessionStorage as sessionStorage,
    // @deprecate
    createIndexedDBStorage as indexedDBStorage
}
