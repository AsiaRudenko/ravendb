import app = require("durandal/app");
import appUrl = require("common/appUrl");
import viewModelBase = require("viewmodels/viewModelBase");
import getDatabaseStatsCommand = require("commands/resources/getDatabaseStatsCommand");
import aceEditorBindingHandler = require("common/bindingHelpers/aceEditorBindingHandler");
import messagePublisher = require("common/messagePublisher");
import datePickerBindingHandler = require("common/bindingHelpers/datePickerBindingHandler");
import deleteDocumentsMatchingQueryConfirm = require("viewmodels/database/query/deleteDocumentsMatchingQueryConfirm");
import querySyntax = require("viewmodels/database/query/querySyntax");
import deleteDocsMatchingQueryCommand = require("commands/database/documents/deleteDocsMatchingQueryCommand");
import notificationCenter = require("common/notifications/notificationCenter");
import queryCommand = require("commands/database/query/queryCommand");
import queryCompleter = require("common/queryCompleter");
import database = require("models/resources/database");
import querySort = require("models/database/query/querySort");
import document = require("models/database/documents/document");
import queryStatsDialog = require("viewmodels/database/query/queryStatsDialog");
import savedQueriesStorage = require("common/storage/savedQueriesStorage");
import queryUtil = require("common/queryUtil");
import eventsCollector = require("common/eventsCollector");
import queryCriteria = require("models/database/query/queryCriteria");
import documentBasedColumnsProvider = require("widgets/virtualGrid/columns/providers/documentBasedColumnsProvider");
import virtualColumn = require("widgets/virtualGrid/columns/virtualColumn");
import virtualGridController = require("widgets/virtualGrid/virtualGridController");
import columnPreviewPlugin = require("widgets/virtualGrid/columnPreviewPlugin");
import textColumn = require("widgets/virtualGrid/columns/textColumn");
import columnsSelector = require("viewmodels/partial/columnsSelector");
import endpoints = require("endpoints");

type queryResultTab = "results" | "includes";

type stringSearchType = "Starts With" | "Ends With" | "Contains" | "Exact";

type rangeSearchType = "Numeric Double" | "Numeric Long" | "Alphabetical" | "Datetime";

type fetcherType = (skip: number, take: number) => JQueryPromise<pagedResult<document>>;

class query extends viewModelBase {

    static readonly recentQueryLimit = 6;
    static readonly recentKeyword = 'Recent Query';

    static readonly ContainerSelector = "#queryContainer";
    static readonly $body = $("body");

    static readonly SearchTypes: stringSearchType[] = ["Exact", "Starts With", "Ends With", "Contains"];
    static readonly RangeSearchTypes: rangeSearchType[] = ["Numeric Double", "Numeric Long", "Alphabetical", "Datetime"];
    static readonly SortTypes: querySortType[] = ["Ascending", "Descending", "Range Ascending", "Range Descending"];

    static lastQuery = new Map<string, string>();

    hasAnySavedQuery = ko.pureComputed(() => this.savedQueries().length > 0);

    filteredQueries = ko.pureComputed(() => {
        let text = this.filters.searchText();

        if (!text) {
            return this.savedQueries();
        }

        text = text.toLowerCase();

        return this.savedQueries().filter(x => x.name.toLowerCase().includes(text));
    });

    filters = {
        searchText: ko.observable<string>()
    };

    previewItem = ko.observable<storedQueryDto>();

    previewCode = ko.pureComputed(() => {
        const item = this.previewItem();
        if (!item) {
            return "";
        }

        return item.queryText;
    });

    inSaveMode = ko.observable<boolean>();
    
    querySaveName = ko.observable<string>();
    saveQueryValidationGroup: KnockoutValidationGroup;

    private gridController = ko.observable<virtualGridController<any>>();

    savedQueries = ko.observableArray<storedQueryDto>();

    indexes = ko.observableArray<Raven.Client.Documents.Operations.IndexInformation>();

    criteria = ko.observable<queryCriteria>(queryCriteria.empty());
    cacheEnabled = ko.observable<boolean>(true);

    private indexEntrieStateWasTrue: boolean = false; // Used to save current query settings when switching to a 'dynamic' index

    columnsSelector = new columnsSelector<document>();

    queryFetcher = ko.observable<fetcherType>();
    includesFetcher = ko.observable<fetcherType>();
    effectiveFetcher = this.queryFetcher;
    
    queryStats = ko.observable<Raven.Client.Documents.Queries.QueryResult<any, any>>();
    staleResult: KnockoutComputed<boolean>;
    dirtyResult = ko.observable<boolean>();
    currentTab = ko.observable<queryResultTab>("results");
    includesCache = new Map<string, document>();
    totalResults: KnockoutComputed<number>;
    hasMoreUnboundedResults = ko.observable<boolean>(false);
    totalIncludes = ko.observable<number>(0);

    canDeleteDocumentsMatchingQuery: KnockoutComputed<boolean>;
    isMapReduceIndex: KnockoutComputed<boolean>;
    isDynamicIndex: KnockoutComputed<boolean>;
    isAutoIndex: KnockoutComputed<boolean>;

    private columnPreview = new columnPreviewPlugin<document>();

    hasEditableIndex: KnockoutComputed<boolean>;
    queryCompleter: queryCompleter;
    queryHasFocus = ko.observable<boolean>();

    editIndexUrl: KnockoutComputed<string>;
    indexPerformanceUrl: KnockoutComputed<string>;
    termsUrl: KnockoutComputed<string>;
    visualizerUrl: KnockoutComputed<string>;
    rawJsonUrl = ko.observable<string>();
    csvUrl = ko.observable<string>();

    isLoading = ko.observable<boolean>(false);
    containsAsterixQuery: KnockoutComputed<boolean>; // query contains: *.* ?

    queriedIndex: KnockoutComputed<string>;
    queriedIndexLabel: KnockoutComputed<string>;
    queriedIndexDescription: KnockoutComputed<string>;
    
    isEmptyFieldsResult = ko.observable<boolean>(false);

    $downloadForm: JQuery;

    /*TODO
    isTestIndex = ko.observable<boolean>(false);
    
    selectedResultIndices = ko.observableArray<number>();
    
    enableDeleteButton: KnockoutComputed<boolean>;
    warningText = ko.observable<string>();
    isWarning = ko.observable<boolean>(false);
    
    indexSuggestions = ko.observableArray<indexSuggestion>([]);
    showSuggestions: KnockoutComputed<boolean>;

    static queryGridSelector = "#queryResultsGrid";*/

    private hideSaveQueryHandler = (e: Event) => {
        if ($(e.target).closest(".query-save").length === 0) {
            this.inSaveMode(false);
        }
    };

    constructor() {
        super();
        _.bindAll(this, ...["previewQuery", "removeQuery", "useQuery"] as Array<keyof this>);

        this.queryCompleter = queryCompleter.remoteCompleter(this.activeDatabase, this.indexes, "Select");
        aceEditorBindingHandler.install();
        datePickerBindingHandler.install();

        this.initObservables();
        this.initValidation();

        this.bindToCurrentInstance("runRecentQuery");
    }

    private initObservables() {
        this.queriedIndex = ko.pureComputed(() => {
            const stats = this.queryStats();
            if (!stats)
                return null;

            return stats.IndexName;
        });

        this.queriedIndexLabel = ko.pureComputed(() => {
            const indexName = this.queriedIndex();

            if (indexName === "AllDocs") {
                return "All Documents";
            }

            return indexName;
        });

        this.queriedIndexDescription = ko.pureComputed(() => {
            const indexName = this.queriedIndex();

            if (!indexName)
                return "";
                    
            if (indexName === "AllDocs") {
                return "All Documents";
            }

            const collectionRegex = /collection\/(.*)/;
            let m;
            if (m = indexName.match(collectionRegex)) {
                return m[1];
            }

            return indexName;
        });

        this.hasEditableIndex = ko.pureComputed(() => {
            const indexName = this.queriedIndex();
            if (!indexName)
                return false;

            return !indexName.startsWith(queryUtil.DynamicPrefix) &&
                indexName !== queryUtil.AllDocs;
        });

        this.editIndexUrl = ko.pureComputed(() =>
            this.queriedIndex() ? appUrl.forEditIndex(this.queriedIndex(), this.activeDatabase()) : null);

        this.indexPerformanceUrl = ko.pureComputed(() =>
            this.queriedIndex() ? appUrl.forIndexPerformance(this.activeDatabase(), this.queriedIndex()) : null);

        this.termsUrl = ko.pureComputed(() =>
            this.queriedIndex() ? appUrl.forTerms(this.queriedIndex(), this.activeDatabase()) : null);

        this.visualizerUrl = ko.pureComputed(() =>
            this.queriedIndex() ? appUrl.forVisualizer(this.activeDatabase(), this.queriedIndex()) : null);

        this.isMapReduceIndex = ko.pureComputed(() => {
            const indexName = this.queriedIndex();
            if (!indexName)
                return false;

            const indexes = this.indexes() || [];
            const currentIndex = indexes.find(i => i.Name === indexName);
            return !!currentIndex && (currentIndex.Type === "AutoMapReduce" || currentIndex.Type === "MapReduce");
        });

        this.isDynamicIndex = ko.pureComputed(() => {
            const indexName = this.queriedIndex();
            if (!indexName)
                return false;

            const indexes = this.indexes() || [];
            const currentIndex = indexes.find(i => i.Name === indexName);
            return !currentIndex;
        });
        
        this.isAutoIndex = ko.pureComputed(() => {
            const indexName = this.queriedIndex();
            if (!indexName)
                return false;
            
            return indexName.toLocaleLowerCase().startsWith(queryUtil.AutoPrefix);
        });

        this.canDeleteDocumentsMatchingQuery = ko.pureComputed(() => {
            return !this.isMapReduceIndex() && !this.isDynamicIndex();
        });

        this.containsAsterixQuery = ko.pureComputed(() => this.criteria().queryText().includes("*.*"));

        this.staleResult = ko.pureComputed(() => {
            //TODO: return false for test index
            const stats = this.queryStats();
            return stats ? stats.IsStale : false;
        });

        this.cacheEnabled.subscribe(() => {
            eventsCollector.default.reportEvent("query", "toggle-cache");
        });

        this.isLoading.extend({ rateLimit: 100 });

        const criteria = this.criteria();

        criteria.showFields.subscribe(() => this.runQuery());   
      
        criteria.indexEntries.subscribe((checked) => {
            if (checked && this.isDynamicIndex()) {
                criteria.indexEntries(false);
            } else {
                // run index entries option only if not dynamic index
                this.runQuery();
            }
        });

        criteria.name.extend({
            required: true
        });

        this.totalResults = ko.pureComputed(() => {
            const stats = this.queryStats();
            if (!stats) {
                return 0;
            }
            
            return stats.TotalResults || 0;
        });
        

         /* TODO
        this.showSuggestions = ko.computed<boolean>(() => {
            return this.indexSuggestions().length > 0;
        });

        this.selectedIndex.subscribe(index => this.onIndexChanged(index));
        });*/

        this.inSaveMode.subscribe(enabled => {
            const $input = $(".query-save .form-control");
            if (enabled) {
                $input.show();
                window.addEventListener("click", this.hideSaveQueryHandler, true);
            } else {
                this.saveQueryValidationGroup.errors.showAllMessages(false);
                window.removeEventListener("click", this.hideSaveQueryHandler, true);
                setTimeout(() => $input.hide(), 200);
            }
        });
    }

    private initValidation() {
        this.querySaveName.extend({
            required: true
        });
        
        this.saveQueryValidationGroup = ko.validatedObservable({
            querySaveName: this.querySaveName
        });
    }

    canActivate(args: any) {
        super.canActivate(args);

        this.loadSavedQueries();

        return true;
    }

    activate(indexNameOrRecentQueryHash?: string) {
        super.activate(indexNameOrRecentQueryHash);

        this.updateHelpLink('KCIMJK');
        
        const db = this.activeDatabase();

        return this.fetchAllIndexes(db)
            .done(() => this.selectInitialQuery(indexNameOrRecentQueryHash));
    }

    deactivate(): void {
        super.deactivate();

        const queryText = this.criteria().queryText();

        this.saveLastQuery(queryText);
    }

    private saveLastQuery(queryText: string) {
        query.lastQuery.set(this.activeDatabase().name, queryText);
    }

    attached() {
        super.attached();

        this.createKeyboardShortcut("ctrl+enter", () => this.runQuery(), query.ContainerSelector);

        /* TODO
        this.createKeyboardShortcut("F2", () => this.editSelectedIndex(), query.containerSelector);
        this.createKeyboardShortcut("alt+c", () => this.focusOnQuery(), query.containerSelector);
        this.createKeyboardShortcut("alt+r", () => this.runQuery(), query.containerSelector); // Using keyboard shortcut here, rather than HTML's accesskey, so that we don't steal focus from the editor.
        */

        this.registerDisposableHandler($(window), "storage", () => this.loadSavedQueries());
    }

    compositionComplete() {
        super.compositionComplete();

        this.$downloadForm = $("#exportCsvForm");
        
        this.setupDisableReasons();

        const grid = this.gridController();

        const documentsProvider = new documentBasedColumnsProvider(this.activeDatabase(), grid, {
            enableInlinePreview: true
        });

        if (!this.queryFetcher())
            this.queryFetcher(() => $.when({
                items: [] as document[],
                totalResultCount: 0
            }));
        
        this.includesFetcher(() => {
            const allIncludes = Array.from(this.includesCache.values());
            return $.when({
                items: allIncludes.map(x => new document(x)),
                totalResultCount: allIncludes.length
            });
        });

        this.columnsSelector.init(grid,
            (s, t, c) => this.effectiveFetcher()(s, t),
            (w, r) => documentsProvider.findColumns(w, r), (results: pagedResult<document>) => documentBasedColumnsProvider.extractUniquePropertyNames(results));

        grid.headerVisible(true);

        grid.dirtyResults.subscribe(dirty => this.dirtyResult(dirty));

        this.queryFetcher.subscribe(() => grid.reset());

        this.columnPreview.install("virtual-grid", ".tooltip", (doc: document, column: virtualColumn, e: JQueryEventObject, onValue: (context: any) => void) => {
            if (column instanceof textColumn) {
                const value = column.getCellValue(doc);
                if (!_.isUndefined(value)) {
                    const json = JSON.stringify(value, null, 4);
                    const html = Prism.highlight(json, (Prism.languages as any).javascript);
                    onValue(html);
                }
            }
        });
        
        this.queryHasFocus(true);
    }

    private loadSavedQueries() {

        const db = this.activeDatabase();

        this.savedQueries(savedQueriesStorage.getSavedQueries(db));
        
        const myLastQuery = query.lastQuery.get(db.name);

        if (myLastQuery) {
            this.criteria().queryText(myLastQuery);
        }
    }

    private fetchAllIndexes(db: database): JQueryPromise<any> {
        return new getDatabaseStatsCommand(db)
            .execute()
            .done((results: Raven.Client.Documents.Operations.DatabaseStatistics) => {
                this.indexes(results.Indexes);
            });
    }

    selectInitialQuery(indexNameOrRecentQueryHash: string) {
        if (!indexNameOrRecentQueryHash) {
            return;
        } else if (this.indexes().find(i => i.Name === indexNameOrRecentQueryHash) ||
            indexNameOrRecentQueryHash.startsWith(queryUtil.DynamicPrefix) || 
            indexNameOrRecentQueryHash === queryUtil.AllDocs) {
            this.runQueryOnIndex(indexNameOrRecentQueryHash);
        } else if (indexNameOrRecentQueryHash.indexOf("recentquery-") === 0) {
            const hash = parseInt(indexNameOrRecentQueryHash.substr("recentquery-".length), 10);
            const matchingQuery = this.savedQueries().find(q => q.hash === hash);
            if (matchingQuery) {
                this.runRecentQuery(matchingQuery);
            } else {
                this.navigate(appUrl.forQuery(this.activeDatabase()));
            }
        } else if (indexNameOrRecentQueryHash) {
            messagePublisher.reportError(`Could not find index or recent query: ${indexNameOrRecentQueryHash}`);
            // fallback to All Documents, but show error
            this.runQueryOnIndex(queryUtil.AllDocs);
        }
    }

    runQueryOnIndex(indexName: string) {
        this.criteria().setSelectedIndex(indexName);

        if (this.isDynamicIndex() && this.criteria().indexEntries()) {
            this.criteria().indexEntries(false);
            this.indexEntrieStateWasTrue = true; // save the state..
        }

        if ((!this.isDynamicIndex() && this.indexEntrieStateWasTrue)) {
            this.criteria().indexEntries(true);
            this.indexEntrieStateWasTrue = false;
        }

        this.runQuery();

        const url = appUrl.forQuery(this.activeDatabase(), indexName);
        this.updateUrl(url);
    }

    runQuery() {
        if (!this.isValid(this.criteria().validationGroup)) {
            return;
        }
        
        this.columnsSelector.reset();
        
        this.effectiveFetcher = this.queryFetcher;
        this.currentTab("results");
        this.includesCache.clear();
        
        this.isEmptyFieldsResult(false);
        
        eventsCollector.default.reportEvent("query", "run");
        const criteria = this.criteria();

        if (criteria.queryText()) {
            this.isLoading(true);

            const database = this.activeDatabase();

            //TODO: this.currentColumnsParams().enabled(this.showFields() === false && this.indexEntries() === false);

            const queryCmd = new queryCommand(database, 0, 25, this.criteria(), !this.cacheEnabled());

            this.rawJsonUrl(appUrl.forDatabaseQuery(database) + queryCmd.getUrl());
            this.csvUrl(queryCmd.getCsvUrl());

            const resultsFetcher = (skip: number, take: number) => {
                const command = new queryCommand(database, skip, take + 1, this.criteria(), !this.cacheEnabled());
                
                const resultsTask = $.Deferred<pagedResultWithIncludes<document>>();
                const queryForAllFields = this.criteria().showFields();
                                
                // Note: 
                // When server resoponse is '304 Not Modified' then the browser cached data contains duration time from the 'first' execution  
                // If we ask browser to report the 304 state then 'response content' is empty 
                // This is why we need to measure the execution time here ourselves..
                const startQueryTime = new Date().getTime();                             
                
                command.execute()
                    .always(() => {
                        this.isLoading(false);
                    })
                    .done((queryResults: pagedResultWithIncludes<document>) => {
                        this.hasMoreUnboundedResults(false);
                    
                        if (queryResults.totalResultCount === -1) {
                            // unbounded result set
                            if (queryResults.items.length === take + 1) {
                                // returned all or have more
                                this.hasMoreUnboundedResults(true);
                                queryResults.totalResultCount = skip + take + 30;
                            } else {
                                queryResults.totalResultCount = skip + queryResults.items.length;
                            }
                            
                            queryResults.additionalResultInfo.TotalResults = queryResults.totalResultCount;
                        }
                    
                        const endQueryTime = new Date().getTime();
                        queryResults.additionalResultInfo.DurationInMs = Math.min(endQueryTime-startQueryTime, queryResults.additionalResultInfo.DurationInMs);
                        
                        const emptyFieldsResult = queryForAllFields 
                            && queryResults.totalResultCount > 0 
                            && _.every(queryResults.items, x => x.getDocumentPropertyNames().length === 0);
                        
                        if (emptyFieldsResult) {
                            resultsTask.resolve({
                               totalResultCount: 0,
                               includes: {},
                               items: [] 
                            });
                            this.isEmptyFieldsResult(true);
                            this.queryStats(queryResults.additionalResultInfo);
                        } else {
                            resultsTask.resolve(queryResults);
                            this.queryStats(queryResults.additionalResultInfo);
                            this.onIncludesLoaded(queryResults.includes);
                        }
                        this.saveLastQuery("");
                        this.saveRecentQuery();
                    })
                    .fail((request: JQueryXHR) => {
                        resultsTask.reject(request);
                    });
                
                return resultsTask;
            };

            this.queryFetcher(resultsFetcher);
            this.recordQueryRun(this.criteria());
        }
    }

    saveQuery() {
        if (this.inSaveMode()) {
            eventsCollector.default.reportEvent("query", "save");

            if (this.isValid(this.saveQueryValidationGroup)) {
                this.criteria().name(this.querySaveName());
                this.saveQueryInStorage(false);
                this.querySaveName(null);
                this.saveQueryValidationGroup.errors.showAllMessages(false);
                messagePublisher.reportSuccess("Query saved successfully");
            }
        } else {
            if (this.isValid(this.criteria().validationGroup)) {
                this.inSaveMode(true);
            }
        }
    }

    private saveRecentQuery() {
        const name = this.getRecentQueryName();
        this.criteria().name(name);
        this.saveQueryInStorage(true);
    }

    private saveQueryInStorage(isRecent: boolean) {
        const dto = this.criteria().toStorageDto();
        dto.recentQuery = isRecent;
        this.appendQuery(dto);
        savedQueriesStorage.storeSavedQueries(this.activeDatabase(), this.savedQueries());

        this.criteria().name("");
        this.loadSavedQueries();
    }

    appendQuery(doc: storedQueryDto) {
        if (doc.recentQuery) {
            const existing = this.savedQueries().find(query => query.hash === doc.hash);
            if (existing) {
                this.savedQueries.remove(existing);
                this.savedQueries.unshift(doc);
            } else {
                this.removeLastRecentQueryIfMoreThanLimit();
                this.savedQueries.unshift(doc);
            }
        } else {
            const existing = this.savedQueries().find(x => x.name === doc.name);
            if (existing) {
                this.savedQueries.replace(existing, doc);
            } else {
                this.savedQueries.unshift(doc);
            }
        }
    }

    private removeLastRecentQueryIfMoreThanLimit() {
        this.savedQueries()
            .filter(x => x.recentQuery)
            .filter((_, idx) => idx >= query.recentQueryLimit)
            .forEach(x => this.savedQueries.remove(x));
    }

    private getRecentQueryName(): string {

        const collectionIndexName = queryUtil.getCollectionOrIndexName(this.criteria().queryText());

        return query.recentKeyword + " (" + collectionIndexName + ")";
    }

    previewQuery(item: storedQueryDto) {
        this.previewItem(item);
    }

    useQuery() {
        const queryDoc = this.criteria();
        queryDoc.copyFrom(this.previewItem());
        
        // Reset settings
        this.cacheEnabled(true);
        this.criteria().indexEntries(false);
        this.criteria().showFields(false);
        
        this.runQuery();
    }

    removeQuery(item: storedQueryDto) {
        this.confirmationMessage("Query", `Are you sure you want to delete query '${item.name}'?`, ["Cancel", "Delete"])
            .done(result => {
                if (result.can) {

                    if (this.previewItem() === item) {
                        this.previewItem(null);
                    }

                    savedQueriesStorage.removeSavedQueryByHash(this.activeDatabase(), item.hash);
                    this.loadSavedQueries();
                }
            });
    }
    
    private onIncludesLoaded(includes: dictionary<any>) {
        _.forIn(includes, (doc, id) => {
            this.includesCache.set(id, doc);
        });
        
        this.totalIncludes(this.includesCache.size);
    }

    refresh() {
        this.gridController().reset(true);
    }
    
    openQueryStats() {
        //TODO: work on explain in dialog
        eventsCollector.default.reportEvent("query", "show-stats");
        const viewModel = new queryStatsDialog(this.queryStats(), this.activeDatabase());
        app.showBootstrapDialog(viewModel);
    }

    private recordQueryRun(criteria: queryCriteria) {
        const newQuery: storedQueryDto = criteria.toStorageDto();

        const queryUrl = appUrl.forQuery(this.activeDatabase(), newQuery.hash);
        this.updateUrl(queryUrl);        
    }

    runRecentQuery(storedQuery: storedQueryDto) {
        eventsCollector.default.reportEvent("query", "run-recent");

        const criteria = this.criteria();

        criteria.updateUsing(storedQuery);

        this.runQuery();
    }

    getRecentQuerySortText(sorts: string[]) {
        if (sorts.length > 0) {
            return sorts
                .map(s => querySort.fromQuerySortString(s).toHumanizedString())
                .join(", ");
        }

        return "";
    }

    deleteDocsMatchingQuery() {
        eventsCollector.default.reportEvent("query", "delete-documents");
        // Run the query so that we have an idea of what we'll be deleting.
        this.runQuery();
        this.queryFetcher()(0, 1)
            .done((results) => {
                if (results.totalResultCount === 0) {
                    app.showBootstrapMessage("There are no documents matching your query.", "Nothing to do");
                } else {
                    this.promptDeleteDocsMatchingQuery(results.totalResultCount);
                }
            });
    }

    private promptDeleteDocsMatchingQuery(resultCount: number) {
        const criteria = this.criteria();
        const db = this.activeDatabase();
        const viewModel = new deleteDocumentsMatchingQueryConfirm(this.queriedIndex(), criteria.queryText(), resultCount, db);
        app.showBootstrapDialog(viewModel)
           .done((result) => {
                if (result) {
                    new deleteDocsMatchingQueryCommand(criteria.queryText(), this.activeDatabase())
                        .execute()
                        .done((operationId: operationIdDto) => {
                            this.monitorDeleteOperation(db, operationId.OperationId);
                        });
                }
           });
    }

    syntaxHelp() {
        const viewmodel = new querySyntax();
        app.showBootstrapDialog(viewmodel);
    }

    private monitorDeleteOperation(db: database, operationId: number) {
        notificationCenter.instance.openDetailsForOperationById(db, operationId);

        notificationCenter.instance.monitorOperation(db, operationId)
            .done(() => {
                messagePublisher.reportSuccess("Successfully deleted documents");
                this.refresh();
            })
            .fail((exception: Raven.Client.Documents.Operations.OperationExceptionResult) => {
                messagePublisher.reportError("Could not delete documents: " + exception.Message, exception.Error, null, false);
            });
    }
    
    goToResultsTab() {
        this.currentTab("results");
        this.effectiveFetcher = this.queryFetcher;

        this.columnsSelector.reset();
        this.refresh();
    }
    
    goToIncludesTab() {
        this.currentTab("includes");
        this.effectiveFetcher = this.includesFetcher;

        this.columnsSelector.reset();
        this.refresh();
    }

    exportCsv() {
        eventsCollector.default.reportEvent("query", "export-csv");

        const args = {
            format: "csv",
        };

        const payload = {
            Query: this.criteria().queryText()
        };

        $("input[name=ExportOptions]").val(JSON.stringify(payload));

        const url = appUrl.forDatabaseQuery(this.activeDatabase()) + endpoints.databases.streaming.streamsQueries + appUrl.urlEncodeArgs(args);
        this.$downloadForm.attr("action", url);
        this.$downloadForm.submit();
    }
}
export = query;