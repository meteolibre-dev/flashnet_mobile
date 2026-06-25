package main

// ============================================================================
// cache.go — Thread-safe LRU cache for rendered PNG tiles
// ============================================================================

import (
	"container/list"
	"sync"
)

// CacheKey is the composite key for a tile cache entry.
type CacheKey struct {
	Z, X, Y  int
	Band     string
	Time     string
	RunTime  string
}

// LRUCache is a thread-safe fixed-size LRU cache for byte slices (PNG tiles).
type LRUCache struct {
	maxSize int
	mu      sync.Mutex
	items   map[CacheKey]*list.Element
	order   *list.List // front = oldest, back = newest
	totalBytes int64
}

type cacheEntry struct {
	key   CacheKey
	value []byte
}

// NewLRUCache creates a new LRU cache with the given maximum number of entries.
func NewLRUCache(maxSize int) *LRUCache {
	return &LRUCache{
		maxSize: maxSize,
		items:   make(map[CacheKey]*list.Element, maxSize),
		order:   list.New(),
	}
}

// Get returns the cached value and true if found, or nil/false if not.
func (c *LRUCache) Get(key CacheKey) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		c.order.MoveToBack(elem) // mark as most recently used
		return elem.Value.(*cacheEntry).value, true
	}
	return nil, false
}

// Put inserts or updates a cache entry, evicting the oldest if at capacity.
func (c *LRUCache) Put(key CacheKey, value []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		c.totalBytes += int64(len(value)) - int64(len(elem.Value.(*cacheEntry).value))
		elem.Value.(*cacheEntry).value = value
		c.order.MoveToBack(elem)
		return
	}

	entry := &cacheEntry{key: key, value: value}
	elem := c.order.PushBack(entry)
	c.items[key] = elem
	c.totalBytes += int64(len(value))

	// Evict oldest if over capacity
	for c.order.Len() > c.maxSize {
		oldest := c.order.Front()
		if oldest == nil {
			break
		}
		e := oldest.Value.(*cacheEntry)
		c.order.Remove(oldest)
		delete(c.items, e.key)
		c.totalBytes -= int64(len(e.value))
	}
}

// InvalidateAll clears all cache entries. Returns the number of entries removed.
func (c *LRUCache) InvalidateAll() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := len(c.items)
	c.items = make(map[CacheKey]*list.Element, c.maxSize)
	c.order = list.New()
	c.totalBytes = 0
	return n
}

// InvalidateRun evicts entries whose RunTime differs from the given run_time.
// Returns the number of entries removed.
func (c *LRUCache) InvalidateRun(runTime string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	var toRemove []CacheKey
	for key := range c.items {
		if key.RunTime != runTime {
			toRemove = append(toRemove, key)
		}
	}
	for _, key := range toRemove {
		elem := c.items[key]
		e := elem.Value.(*cacheEntry)
		c.order.Remove(elem)
		delete(c.items, key)
		c.totalBytes -= int64(len(e.value))
	}
	return len(toRemove)
}

// Stats returns current cache statistics for monitoring.
type CacheStats struct {
	Entries    int     `json:"entries"`
	MaxEntries int     `json:"max_entries"`
	TotalBytes int64   `json:"total_bytes"`
	TotalMB    float64 `json:"total_mb"`
}

func (c *LRUCache) Stats() CacheStats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return CacheStats{
		Entries:    len(c.items),
		MaxEntries: c.maxSize,
		TotalBytes: c.totalBytes,
		TotalMB:    float64(c.totalBytes) / 1024.0 / 1024.0,
	}
}
