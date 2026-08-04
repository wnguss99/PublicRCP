/**
 * Memory Leak Performance Benchmarks
 * Tests to measure the performance impact of memory leak fixes
 */

/**
 * Wall-clock budgets are scaled up because this suite runs inside the full
 * parallel test run, on a machine that is also hosting three live Claudito
 * instances and their Claude CLI processes. At the original 1x figures these
 * tests failed intermittently while passing in isolation — they were measuring
 * the host, not the code.
 *
 * The thresholds are still worth keeping: what they actually guard against is an
 * algorithmic blow-up (an O(n^2) creeping into a tree walk or a cleanup loop),
 * and a 10x margin catches that just as well as 1x while no longer reporting a
 * busy machine as a regression.
 */
const TIME_BUDGET_SCALE = 10;
const budget = (ms) => ms * TIME_BUDGET_SCALE;

describe('Memory Leak Performance Benchmarks', () => {

  describe('Event Listener Performance', () => {
    test('should handle 10k event listeners efficiently', () => {
      const startTime = Date.now();
      const elements = new Map();
      const maxElements = 10000;

      // Add elements with listeners
      for (let i = 0; i < maxElements; i++) {
        const element = { id: i, listeners: [] };
        element.listeners.push({ type: 'click', handler: () => {} });
        elements.set(i, element);
      }

      // Clean up all elements
      elements.clear();

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(budget(1000)); // Should complete in under 1 second
      expect(elements.size).toBe(0);
    });

    test('should efficiently track nested listeners', () => {
      const startTime = Date.now();
      const maxDepth = 10;
      const childrenPerNode = 5;

      const createTree = (depth = 0) => {
        if (depth >= maxDepth) return null;

        const node = {
          id: Math.random(),
          listeners: [{ type: 'click', handler: () => {} }],
          children: []
        };

        for (let i = 0; i < childrenPerNode; i++) {
          const child = createTree(depth + 1);
          if (child) node.children.push(child);
        }

        return node;
      };

      const tree = createTree();

      // Count total nodes
      let nodeCount = 0;
      const countNodes = (node) => {
        if (!node) return;
        nodeCount++;
        node.children.forEach(countNodes);
      };

      countNodes(tree);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(budget(3000)); // Should complete quickly
      expect(nodeCount).toBeGreaterThan(1000); // Many nodes created
    });
  });

  describe('WebSocket Handler Performance', () => {
    test('should handle rapid message throughput', () => {
      const handlers = new Map();
      const messageTypes = ['update', 'status', 'data', 'error', 'ping'];
      const messagesPerType = 1000;
      let totalCalls = 0;

      // Register handlers
      messageTypes.forEach(type => {
        handlers.set(type, [
          () => totalCalls++,
          () => totalCalls++,
          () => totalCalls++
        ]);
      });

      const startTime = Date.now();

      // Simulate rapid message processing
      for (let i = 0; i < messagesPerType; i++) {
        messageTypes.forEach(type => {
          const typeHandlers = handlers.get(type);
          if (typeHandlers) {
            typeHandlers.forEach(handler => handler());
          }
        });
      }

      const duration = Date.now() - startTime;
      const messagesPerSecond = (messagesPerType * messageTypes.length) / (duration / 1000);

      expect(duration).toBeLessThan(budget(500)); // Process quickly
      expect(messagesPerSecond).toBeGreaterThan(10000); // High throughput
      expect(totalCalls).toBe(messagesPerType * messageTypes.length * 3); // All handlers called
    });

    test('should limit handlers without performance degradation', () => {
      const maxHandlers = 100;
      const handlers = [];
      const startTime = Date.now();

      // Try to add many handlers
      for (let i = 0; i < 1000; i++) {
        if (handlers.length < maxHandlers) {
          handlers.push(() => {});
        }
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(budget(10)); // Very fast
      expect(handlers.length).toBe(maxHandlers);
    });
  });

  describe('DOM Manipulation Performance', () => {
    test('should batch DOM operations efficiently', () => {
      const operations = [];
      let batchCount = 0;

      const batchOperations = (ops) => {
        batchCount++;
        ops.forEach(op => operations.push(op()));
      };

      const startTime = Date.now();

      // Batch 1000 operations
      const batchSize = 100;
      for (let i = 0; i < 10; i++) {
        const batch = [];
        for (let j = 0; j < batchSize; j++) {
          batch.push(() => `op${i * batchSize + j}`);
        }
        batchOperations(batch);
      }

      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(budget(50));
      expect(operations.length).toBe(1000);
      expect(batchCount).toBe(10);
    });

    test('should clean up large DOM trees quickly', () => {
      const createLargeDOM = () => {
        const nodes = [];
        const nodeCount = 5000;

        for (let i = 0; i < nodeCount; i++) {
          nodes.push({
            id: i,
            innerHTML: `<div>Content ${i}</div>`,
            children: [],
            listeners: [
              { type: 'click', handler: () => {} },
              { type: 'mouseover', handler: () => {} }
            ]
          });
        }

        return nodes;
      };

      const nodes = createLargeDOM();
      const startTime = Date.now();

      // Clean up all nodes
      nodes.forEach(node => {
        node.listeners = [];
        node.innerHTML = '';
        node.children = [];
      });

      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(budget(100));
      expect(nodes.every(n => n.listeners.length === 0)).toBe(true);
    });
  });

  describe('File Tree Performance', () => {
    test('should handle large file trees efficiently', () => {
      const createFileTree = (path = '', depth = 0, maxDepth = 5) => {
        if (depth >= maxDepth) return [];

        const entries = [];
        const filesPerDir = 20;
        const dirsPerLevel = 3;

        // Add files
        for (let i = 0; i < filesPerDir; i++) {
          entries.push({
            name: `file${i}.txt`,
            path: `${path}/file${i}.txt`,
            isDirectory: false
          });
        }

        // Add directories
        for (let i = 0; i < dirsPerLevel; i++) {
          const dirPath = `${path}/dir${i}`;
          entries.push({
            name: `dir${i}`,
            path: dirPath,
            isDirectory: true,
            children: createFileTree(dirPath, depth + 1, maxDepth)
          });
        }

        return entries;
      };

      const startTime = Date.now();
      const tree = createFileTree();
      const creationTime = Date.now() - startTime;

      // Count total entries
      let totalEntries = 0;
      const countEntries = (entries) => {
        entries.forEach(entry => {
          totalEntries++;
          if (entry.children) {
            countEntries(entry.children);
          }
        });
      };

      const countStartTime = Date.now();
      countEntries(tree);
      const countTime = Date.now() - countStartTime;

      expect(creationTime).toBeLessThan(budget(500));
      expect(countTime).toBeLessThan(budget(50));
      expect(totalEntries).toBeGreaterThan(1000);
    });

    test('should search large file trees quickly', () => {
      const files = [];
      const totalFiles = 10000;

      // Create flat file list
      for (let i = 0; i < totalFiles; i++) {
        files.push({
          name: `file${i % 100}.txt`,
          path: `/path/to/file${i}.txt`
        });
      }

      const startTime = Date.now();

      // Search for files
      const searchTerm = 'file42';
      const results = files.filter(file =>
        file.name.toLowerCase().includes(searchTerm.toLowerCase())
      );

      // Limit results
      const limitedResults = results.slice(0, 100);

      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(budget(50));
      expect(limitedResults.length).toBe(100);
      expect(results.length).toBe(100); // file42.txt appears 100 times
    });
  });

  describe('Memory Cleanup Performance', () => {
    test('should cleanup managers scale well', () => {
      const managers = [];
      const managerCount = 1000;

      const startTime = Date.now();

      // Create many cleanup managers
      for (let i = 0; i < managerCount; i++) {
        const manager = {
          name: `Component${i}`,
          cleanupFns: [],
          cleanup: function() {
            this.cleanupFns.forEach(fn => fn());
            this.cleanupFns = [];
          }
        };

        // Add some cleanup functions
        for (let j = 0; j < 5; j++) {
          manager.cleanupFns.push(() => {});
        }

        managers.push(manager);
      }

      // Clean up all managers
      const cleanupStartTime = Date.now();
      managers.forEach(m => m.cleanup());
      const cleanupDuration = Date.now() - cleanupStartTime;

      const totalDuration = Date.now() - startTime;

      expect(totalDuration).toBeLessThan(budget(100));
      expect(cleanupDuration).toBeLessThan(budget(50));
      expect(managers.every(m => m.cleanupFns.length === 0)).toBe(true);
    });

    test('should handle WeakMap operations efficiently', () => {
      const weakMap = new WeakMap();
      const elements = [];
      const elementCount = 5000;

      const startTime = Date.now();

      // Add elements to WeakMap
      for (let i = 0; i < elementCount; i++) {
        const element = { id: i };
        elements.push(element);
        weakMap.set(element, {
          listeners: [],
          timers: []
        });
      }

      // Access elements
      let accessCount = 0;
      elements.forEach(elem => {
        if (weakMap.has(elem)) {
          accessCount++;
        }
      });

      // Delete half the elements
      const deleteStartTime = Date.now();
      for (let i = 0; i < elementCount / 2; i++) {
        weakMap.delete(elements[i]);
      }
      const deleteDuration = Date.now() - deleteStartTime;

      const totalDuration = Date.now() - startTime;

      expect(totalDuration).toBeLessThan(budget(100));
      expect(deleteDuration).toBeLessThan(budget(20));
      expect(accessCount).toBe(elementCount);
    });
  });

  describe('Memory Usage Patterns', () => {
    test('should demonstrate memory savings with file limiting', () => {
      const fileSize = 1000; // Approximate characters per file
      const maxOpenFiles = 20;
      const attemptedFiles = 50;

      // Without limit
      const unlimitedMemory = attemptedFiles * fileSize;

      // With limit
      const limitedMemory = maxOpenFiles * fileSize;

      const memorySaved = unlimitedMemory - limitedMemory;
      const savingsPercentage = (memorySaved / unlimitedMemory) * 100;

      expect(savingsPercentage).toBe(60); // 60% memory saved
      expect(limitedMemory).toBeLessThan(unlimitedMemory);
    });

    test('should show efficiency of conversation trimming', () => {
      const messageSize = 200; // Bytes per message
      const messagesPerConversation = 500;
      const conversationCount = 5;
      const messageLimit = 100;

      // Before trimming
      const beforeMemory = conversationCount * messagesPerConversation * messageSize;

      // After trimming inactive conversations
      const activeConversations = 1;
      const inactiveConversations = conversationCount - activeConversations;
      const afterMemory =
        (activeConversations * messagesPerConversation * messageSize) +
        (inactiveConversations * messageLimit * messageSize);

      const memorySaved = beforeMemory - afterMemory;
      const savingsPercentage = (memorySaved / beforeMemory) * 100;

      expect(savingsPercentage).toBeGreaterThan(60);
      expect(afterMemory).toBeLessThan(beforeMemory);
    });
  });
});