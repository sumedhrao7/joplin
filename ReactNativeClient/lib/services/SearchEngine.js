const { Logger } = require('lib/logger.js');
const { shim } = require('lib/shim.js');
const ItemChange = require('lib/models/ItemChange.js');
const Setting = require('lib/models/Setting.js');
const Note = require('lib/models/Note.js');
const BaseModel = require('lib/BaseModel.js');
const ItemChangeUtils = require('lib/services/ItemChangeUtils');
const { pregQuote, scriptType } = require('lib/string-utils.js');
const removeDiacritics = require('diacritics').remove;

class SearchEngine {

	constructor() {
		this.dispatch = (action) => {};
		this.logger_ = new Logger();
		this.db_ = null;
		this.isIndexing_ = false;
	}

	static instance() {
		if (this.instance_) return this.instance_;
		this.instance_ = new SearchEngine();
		return this.instance_;
	}

	setLogger(logger) {
		this.logger_ = logger;
	}

	logger() {
		return this.logger_;
	}

	setDb(db) {
		this.db_ = db;
	}

	db() {
		return this.db_;
	}

	noteById_(notes, noteId) {
		for (let i = 0; i < notes.length; i++) {
			if (notes[i].id === noteId) return notes[i];
		}
		// The note may have been deleted since the change was recorded. For example in this case:
		// - Note created (Some Change object is recorded)
		// - Note is deleted
		// - ResourceService indexer runs.
		// In that case, there will be a change for the note, but the note will be gone.
		return null;
	}


	async rebuildIndex_() {
		let noteIds = await this.db().selectAll('SELECT id FROM notes WHERE is_conflict = 0 AND encryption_applied = 0');
		noteIds = noteIds.map(n => n.id);

		const lastChangeId = await ItemChange.lastChangeId();

		// First delete content of note_normalized, in case the previous initial indexing failed
		await this.db().exec('DELETE FROM notes_normalized');

		while (noteIds.length) {
			const currentIds = noteIds.splice(0, 100);
			const notes = await Note.modelSelectAll('SELECT id, title, body FROM notes WHERE id IN ("' + currentIds.join('","') + '") AND is_conflict = 0 AND encryption_applied = 0');			
			const queries = [];

			for (let i = 0; i < notes.length; i++) {
				const note = notes[i];
				const n = this.normalizeNote_(note);
				queries.push({ sql: 'INSERT INTO notes_normalized(id, title, body) VALUES (?, ?, ?)', params: [n.id, n.title, n.body] });
			}

			await this.db().transactionExecBatch(queries);
		}

		Setting.setValue('searchEngine.lastProcessedChangeId', lastChangeId);
	}

	scheduleSyncTables() {
		if (this.scheduleSyncTablesIID_) return;

		this.scheduleSyncTablesIID_ = setTimeout(async () => {
			await this.syncTables();
			this.scheduleSyncTablesIID_ = null;
		}, 10000);
	}

	async syncTables() {
		if (this.isIndexing_) return;

		this.isIndexing_ = true;

		this.logger().info('SearchEngine: Updating FTS table...');

		await ItemChange.waitForAllSaved();

		if (!Setting.value('searchEngine.initialIndexingDone')) {
			await this.rebuildIndex_();
			Setting.setValue('searchEngine.initialIndexingDone', true);
			this.isIndexing_ = false;
			return;
		}

		const startTime = Date.now();

		let lastChangeId = Setting.value('searchEngine.lastProcessedChangeId');

		while (true) {
			const changes = await ItemChange.modelSelectAll(`
				SELECT id, item_id, type
				FROM item_changes
				WHERE item_type = ?
				AND id > ?
				ORDER BY id ASC
				LIMIT 100
			`, [BaseModel.TYPE_NOTE, lastChangeId]);

			if (!changes.length) break;

			const noteIds = changes.map(a => a.item_id);
			const notes = await Note.modelSelectAll('SELECT id, title, body FROM notes WHERE id IN ("' + noteIds.join('","') + '") AND is_conflict = 0 AND encryption_applied = 0');
			const queries = [];

			for (let i = 0; i < changes.length; i++) {
				const change = changes[i];

				if (change.type === ItemChange.TYPE_CREATE || change.type === ItemChange.TYPE_UPDATE) {
					queries.push({ sql: 'DELETE FROM notes_normalized WHERE id = ?', params: [change.item_id] });
					const note = this.noteById_(notes, change.item_id);
					if (note) {
						const n = this.normalizeNote_(note);
						queries.push({ sql: 'INSERT INTO notes_normalized(id, title, body) VALUES (?, ?, ?)', params: [change.item_id, n.title, n.body] });
					}
				} else if (change.type === ItemChange.TYPE_DELETE) {
					queries.push({ sql: 'DELETE FROM notes_normalized WHERE id = ?', params: [change.item_id] });
				} else {
					throw new Error('Invalid change type: ' + change.type);
				}

				lastChangeId = change.id;
			}

			await this.db().transactionExecBatch(queries);
			Setting.setValue('searchEngine.lastProcessedChangeId', lastChangeId);
			await Setting.saveAll();
		}

		await ItemChangeUtils.deleteProcessedChanges();

		this.logger().info('SearchEngine: Updated FTS table in ' + (Date.now() - startTime) + 'ms');

		this.isIndexing_ = false;
}

	async countRows() {
		const sql = 'SELECT count(*) as total FROM notes_fts'
		const row = await this.db().selectOne(sql);
		return row && row['total'] ? row['total'] : 0;
	}

	columnIndexesFromOffsets_(offsets) {
		const occurenceCount = Math.floor(offsets.length / 4);
		const indexes = [];

		for (let i = 0; i < occurenceCount; i++) {
			const colIndex = offsets[i * 4] - 1;
			if (indexes.indexOf(colIndex) < 0) indexes.push(colIndex);
		}

		return indexes;
	}

	calculateWeight_(offsets, termCount) {
		// Offset doc: https://www.sqlite.org/fts3.html#offsets

		// - If there's only one term in the query string, the content with the most matches goes on top
		// - If there are multiple terms, the result with the most occurences that are closest to each others go on top.
		//   eg. if query is "abcd efgh", "abcd efgh" will go before "abcd XX efgh".
		
		const occurenceCount = Math.floor(offsets.length / 4);

		if (termCount === 1) return occurenceCount;

		let spread = 0;
		let previousDist = null;
		for (let i = 0; i < occurenceCount; i++) {
			const dist = offsets[i * 4 + 2];

			if (previousDist !== null) {
				const delta = dist - previousDist;
				spread += delta;
			}

			previousDist = dist;
		}

		// Divide the number of occurences by the spread so even if a note has many times the searched terms
		// but these terms are very spread appart, they'll be given a lower weight than a note that has the
		// terms once or twice but just next to each others.
		return occurenceCount / spread;
	}

	orderResults_(rows, parsedQuery) {
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const offsets = row.offsets.split(' ').map(o => Number(o));
			row.weight = this.calculateWeight_(offsets, parsedQuery.termCount);
			// row.colIndexes = this.columnIndexesFromOffsets_(offsets);
			// row.offsets = offsets;
		}

		rows.sort((a, b) => {
			if (a.weight < b.weight) return +1;
			if (a.weight > b.weight) return -1;
			return 0;
		});
	}

	// https://stackoverflow.com/a/13818704/561309
	queryTermToRegex(term) {
		while (term.length && term.indexOf('*') === 0) {
			term = term.substr(1);
		}

		let regexString = pregQuote(term);
		if (regexString[regexString.length - 1] === '*') {
			regexString = regexString.substr(0, regexString.length - 2) + '[^' + pregQuote(' \t\n\r,.,+-*?!={}<>|:"\'()[]') + ']' + '*?';
			// regexString = regexString.substr(0, regexString.length - 2) + '.*?';
		}

		return regexString;
	}

	parseQuery(query) {
		const terms = {_:[]};
		
		let inQuote = false;
		let currentCol = '_';
		let currentTerm = '';
		for (let i = 0; i < query.length; i++) {
			const c = query[i];

			if (c === '"') {
				if (inQuote) {
					terms[currentCol].push(currentTerm);
					currentTerm = '';
					inQuote = false;
				} else {
					inQuote = true;
				}
				continue;
			}

			if (c === ' ' && !inQuote) {
				if (!currentTerm) continue;
				terms[currentCol].push(currentTerm);
				currentCol = '_';
				currentTerm = '';
				continue;
			}

			if (c === ':' && !inQuote) {
				currentCol = currentTerm;
				terms[currentCol] = [];
				currentTerm = '';
				continue;
			}

			currentTerm += c;
		}

		if (currentTerm) terms[currentCol].push(currentTerm);

		// Filter terms:
		// - Convert wildcards to regex
		// - Remove columns with no results
		// - Add count of terms

		let termCount = 0;
		const keys = [];
		for (let col in terms) {
			if (!terms.hasOwnProperty(col)) continue;

			if (!terms[col].length) {
				delete terms[col];
				continue;
			}

			for (let i = terms[col].length - 1; i >= 0; i--) {
				const term = terms[col][i];

				// SQlLite FTS doesn't allow "*" queries and neither shall we
				if (term === '*') {
					terms[col].splice(i, 1);
					continue;
				}

				if (term.indexOf('*') >= 0) {
					terms[col][i] = { type: 'regex', value: this.queryTermToRegex(term), scriptType: scriptType(term), originalValue: term };
				} else {
					terms[col][i] = { type: 'text', value: term, scriptType: scriptType(term), originalValue: term };
				}
			}

			termCount += terms[col].length;

			keys.push(col);
		}

		return {
			termCount: termCount,
			keys: keys,
			terms: terms,
		};
	}

	allParsedQueryTerms(parsedQuery) {
		if (!parsedQuery || !parsedQuery.termCount) return [];

		let output = [];
		for (let col in parsedQuery.terms) {
			if (!parsedQuery.terms.hasOwnProperty(col)) continue;
			output = output.concat(parsedQuery.terms[col]);
		}
		return output;
	}

	normalizeText_(text) {
		return removeDiacritics(text.normalize().toLowerCase());
	}

	normalizeNote_(note) {
		const n = Object.assign({}, note);
		n.title = this.normalizeText_(n.title);		
		n.body = this.normalizeText_(n.body);
		return n;
	}

	async basicSearch(query) {
		let p = query.split(' ');
		let temp = [];
		for (let i = 0; i < p.length; i++) {
			let t = p[i].trim();
			if (!t) continue;
			temp.push(t);
		}

		return await Note.previews(null, {
			anywherePattern: '*' + temp.join('*') + '*',
		});
	}

	async search(query) {
		query = this.normalizeText_(query);

		const st = scriptType(query);

		if (!Setting.value('db.ftsEnabled') || ['ja', 'zh', 'ko'].indexOf(st) >= 0) {
			// Non-alphabetical languages aren't support by SQLite FTS (except with extensions which are not available in all platforms)
			return this.basicSearch(query);
		} else {
			const parsedQuery = this.parseQuery(query);
			const sql = 'SELECT id, title, offsets(notes_fts) AS offsets FROM notes_fts WHERE notes_fts MATCH ?'
			try {
				const rows = await this.db().selectAll(sql, [query]);
				this.orderResults_(rows, parsedQuery);
				return rows;
			} catch (error) {
				this.logger().warn('Cannot execute MATCH query: ' + query + ': ' + error.message);
				return [];
			}
		}
	}

	static runInBackground() {
		if (this.isRunningInBackground_) return;

		this.isRunningInBackground_ = true;
		
		this.instance().syncTables();

		setTimeout(() => {
			this.instance().syncTables();
		}, 1000 * 60 * 5);
	}
	
}

module.exports = SearchEngine;