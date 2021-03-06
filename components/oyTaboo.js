/*
 * Copyright 2007-2008 Jesse Andrews and Manish Singh
 *
 * This file may be used under the terms of of the
 * GNU General Public License Version 2 or later (the "GPL"),
 * http://www.gnu.org/licenses/gpl.html
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 */

const TB_CONTRACTID = '@oy/taboo;1';
const TB_CLASSID    = Components.ID('{962a9516-b177-4083-bbe8-e10f47cf8570}');
const TB_CLASSNAME  = 'Taboo Service';

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

const TABOO_DB_FILENAME = 'taboo.sqlite';
const TABOO_EXPORT_DB_FILENAME = TABOO_DB_FILENAME + '.export';

/* from nspr's prio.h */
const PR_RDONLY      = 0x01;
const PR_WRONLY      = 0x02;
const PR_RDWR        = 0x04;
const PR_CREATE_FILE = 0x08;
const PR_APPEND      = 0x10;
const PR_TRUNCATE    = 0x20;
const PR_SYNC        = 0x40;
const PR_EXCL        = 0x80;

const IMAGE_FULL_WIDTH = 500;
const IMAGE_FULL_HEIGHT = 500;

const IMAGE_THUMB_WIDTH = 125;
const IMAGE_THUMB_HEIGHT = 125;

const PREF_DEBUG = 'extensions.taboo.debug';

Cu.import("resource://gre/modules/XPCOMUtils.jsm");


function getObserverService() {
  return Cc['@mozilla.org/observer-service;1']
    .getService(Ci.nsIObserverService);
}

function getBoolPref(prefName, defaultValue) {
  try {
    var prefs = Cc['@mozilla.org/preferences-service;1']
      .getService(Ci.nsIPrefBranch);
    return prefs.getBoolPref(prefName);
  }
  catch (e) {
    return defaultValue;
  }
}


/* MD5 wrapper */
function hex_md5_stream(stream) {
  var hasher = Components.classes["@mozilla.org/security/hash;1"]
    .createInstance(Components.interfaces.nsICryptoHash);
  hasher.init(hasher.MD5);

  hasher.updateFromStream(stream, stream.available());
  var hash = hasher.finish(false);

  var ret = '';
  for (var i = 0; i < hash.length; ++i) {
    var hexChar = hash.charCodeAt(i).toString(16);
    if (hexChar.length == 1)
      ret += '0';
    ret += hexChar;
  }

  return ret;
}

function hex_md5(s) {
  var stream = Components.classes["@mozilla.org/io/string-input-stream;1"]
    .createInstance(Components.interfaces.nsIStringInputStream);
  stream.setData(s, s.length);

  return hex_md5_stream(stream);
}


/*
 * Taboo Info Instance
 */

function TabooInfo(url, title, description, favicon, imageURL, thumbURL,
                   created, updated, data) {
  this.url = url;
  this.title = title;
  this.description = description;
  this.favicon = favicon;
  this.imageURL = imageURL;
  this.thumbURL = thumbURL;
  this.created = new Date(created);
  this.updated = new Date(updated);
  this.data = data;
}

TabooInfo.prototype = {
  getInterfaces: function TI_getInterfaces(countRef) {
    var interfaces = [Ci.oyITabooInfo, Ci.nsIClassInfo, Ci.nsISupports];
    countRef.value = interfaces.length;
    return interfaces;
  },
  getHelperForLanguage: function TI__getHelperForLanguage(language) null,
  contractID: null,
  classDescription: "Taboo Info",
  classID: null,
  implementationLanguage: Ci.nsIProgrammingLanguage.JAVASCRIPT,
  flags: 0,
  QueryInterface: XPCOMUtils.generateQI([Ci.oyITabooInfo, Ci.nsIClassInfo])
}

/*
 * Taboo Service Component
 */


function snapshot(win, outputWidth, outputHeight) {
  var canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");

  var realW = win.innerWidth;
  var realH = win.innerHeight;

  var pW = outputWidth * 1.0 / realW;
  var pH = outputHeight * 1.0 / realH;

  var p = pW;

  if (pH < pW) {
    p = pH;
  }

  var w = p * realW;
  var h = p * realH;

  canvas.setAttribute("width", Math.floor(w));
  canvas.setAttribute("height", Math.floor(h));

  var ctx = canvas.getContext("2d");
  ctx.scale(p, p);
  ctx.drawWindow(win, win.scrollX, win.scrollY, realW, realH, "rgb(0,0,0)");

  var imageData = canvas.toDataURL();
  return win.atob(imageData.substr('data:image/png;base64,'.length));
}

function cleanTabState(aState, aClearPrivateData) {
  var sandbox = new Cu.Sandbox('about:blank');
  var tabState = Cu.evalInSandbox('('+aState+')', sandbox);

  var index = (tabState.index ? tabState.index : tabState.entries.length) - 1;
  var entry = tabState.entries[index];

  if (aClearPrivateData) {
    function deletePrivateData(aEntry) {
      delete aEntry.text;
      delete aEntry.postdata;
    }

    deletePrivateData(entry);

    if (entry.children) {
      for (var i=0; i<entry.children.length; i++) {
        deletePrivateData(entry.children[i]);
      }
    }
  }

  tabState.entries = [entry];
  tabState.index = 1;

  var nativeJSON = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);
  return nativeJSON.encode(tabState);
}


function TabooStorageSQL() {
  this._schema = {
    url         : 'TEXT PRIMARY KEY',
    title       : 'TEXT',
    description : 'TEXT',
    md5         : 'TEXT',
    favicon     : 'TEXT',
    full        : 'TEXT',
    created     : 'INTEGER',
    updated     : 'INTEGER',
    deleted     : 'INTEGER'
  };

  this._tabooDir = Cc['@mozilla.org/file/directory_service;1']
    .getService(Ci.nsIProperties).get('ProfD', Ci.nsILocalFile);
  this._tabooDir.append('taboo');

  if (!this._tabooDir.exists())
    this._tabooDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);

  var dbfile = this._tabooDir.clone();
  dbfile.append(TABOO_DB_FILENAME);

  this._db = this._loadDB(dbfile);
  this._store = this._db.taboo_data;
}

TabooStorageSQL.prototype = {
  save: function TSSQL_save(url, description, data, fullImage, thumbImage) {
    var title = data.entries[data.index - 1].title;

    if (!title) {
      var ios = Cc['@mozilla.org/network/io-service;1']
        .getService(Ci.nsIIOService);
      var uri = ios.newURI(url, null, null);

      if (uri.path.length > 1) {
        var parts = uri.path.split('/');
        while (!title && parts.length)
          title = parts.pop();
      }

      if (!title)
        title = uri.host;
    }

    var updated = Date.now();

    var entry = this._store.find(url);
    var exists = Boolean(entry);

    if (!exists) {
      entry = this._store.new();
      entry.url = url;
      entry.md5 = hex_md5(url);
      entry.title = title;
      entry.created = updated;
    } else if (entry.deleted) {
      entry.title = title;
    }

    if (description != null) {
      entry.description = description;
    }

    entry.updated = updated;
    entry.deleted = null;
    entry.full = data.toSource();

    entry.save();

    this._saveImage(fullImage, this._getImageFile(entry.md5));
    this._saveImage(thumbImage, this._getThumbFile(entry.md5));

    return exists;
  },
  saveFavicon: function TSSQL_saveFavicon(url, favicon) {
    var entry = this._store.find(url);
    if (entry) {
      entry.favicon = favicon;
      entry.save();
    }
  },
  exists: function TSSQL_exists(url) {
    var entry = this._store.find(url);
    return (entry && !entry.deleted);
  },
  update: function TSSQL_update(aURL, aTitle, aDescription) {
    var entry = this._store.find(aURL);
    if (!entry || entry.deleted) {
      return false;
    }

    if (aTitle != null || aDescription != null) {
      if (aTitle != null) {
        entry.title = aTitle;
      }

      if (aDescription != null) {
        entry.description = aDescription;
      }

      entry.updated = Date.now();

      entry.save();
    }

    return true;
  },
  delete: function TSSQL_delete(url) {
    this._deleteOp(url, Date.now());
  },
  undelete: function TSSQL_undelete(url) {
    this._deleteOp(url, null);
  },
  reallyDelete: function TSSQL_reallyDelete(url) {
    var entry = this._store.find(url);
    if (entry) {
      entry.destroy();
    }

    try {
      var file, md5 = hex_md5(url);

      file = this._getImageFile(md5);
      file.remove(false);

      file = this._getThumbFile(md5);
      file.remove(false);
    }
    catch (e) { }
  },
  retrieve: function TSSQL_retrieve(url) {
    var entry = this._store.find(url);
    if (!entry)
      return null;

    var ios = Cc['@mozilla.org/network/io-service;1']
      .getService(Ci.nsIIOService);
    var fileHandler = ios.getProtocolHandler('file')
      .QueryInterface(Ci.nsIFileProtocolHandler);

    var imageFile = this._getImageFile(entry.md5);
    var imageURL = fileHandler.getURLSpecFromFile(imageFile);
    imageURL += '?' + entry.updated;

    var thumbFile = this._getThumbFile(entry.md5);
    var thumbURL;
    if (thumbFile.exists()) {
      thumbURL = fileHandler.getURLSpecFromFile(thumbFile);
      thumbURL += '?' + entry.updated;
    } else {
      thumbURL = imageURL;
    }

    var data = entry.full.replace(/\r\n?/g, '\n');
    return new TabooInfo(url, entry.title, entry.description, entry.favicon,
                         imageURL, thumbURL, entry.created, entry.updated,
                         data);
  },
  getURLs: function TSSQL_getURLs(filter, deleted, aMaxResults) {
    var condition = [];

    var sortkey, sql = '';

    if (filter) {
      sql += '(url LIKE ?1 or title LIKE ?1 or description LIKE ?1) and ';
      // TODO: escape %'s before passing in
      condition.push('%' + filter + '%');
    }

    if (deleted) {
      sql += 'deleted IS NOT NULL';
      sortkey = 'deleted DESC LIMIT ' + aMaxResults;
    } else {
      sql += 'deleted IS NULL';
      sortkey = 'updated DESC LIMIT ' + aMaxResults;
    }

    condition.unshift(sql);

    var results = this._store.find(condition, sortkey);
    return results.map(function(entry) { return entry.url });
  },
  import: function TSSQL__import(aFile) {
    var zipReader = Cc["@mozilla.org/libjar/zip-reader;1"]
                    .createInstance(Ci.nsIZipReader);
    zipReader.open(aFile);

    if (!zipReader.hasEntry(TABOO_EXPORT_DB_FILENAME)) {
      throw "Not a Taboo backup";
    }

    var filesToExtract = [];

    var dbfile = this._tabooDir.clone();
    dbfile.append(TABOO_EXPORT_DB_FILENAME);

    zipReader.extract(TABOO_EXPORT_DB_FILENAME, dbfile);

    var importDB = this._loadDB(dbfile);
    var importStore = importDB.taboo_data;

    var imports = importStore.find(["deleted IS NULL"]);
    for each (var data in imports) {
      var entry = this._store.find(data.url);
      if (entry) {
        if (entry.updated > data.updated) {
          continue;
        }
      } else {
        entry = this._store.new();
      }
      for (var field in this._schema) {
        entry[field] = data[field];
      }
      entry.save();

      filesToExtract.push([ this._getImageFile(entry.md5),
                            this._getThumbFile(entry.md5) ]);
    }

    importDB.close();
    dbfile.remove(false);

    for each (var fileList in filesToExtract) {
      for each (var imageFile in fileList) {
        if (zipReader.hasEntry(imageFile.leafName)) {
          zipReader.extract(imageFile.leafName, imageFile);
        }
      }
    }

    zipReader.close();

    return filesToExtract.length;
  },
  export: function TSSQL__export(aFile) {
    if (aFile.exists()) {
      aFile.remove(false);
    }

    var dbfile = this._tabooDir.clone();
    dbfile.append(TABOO_EXPORT_DB_FILENAME);

    if (dbfile.exists()) {
      dbfile.remove(false);
    }

    var exportDB = this._loadDB(dbfile);
    var exportStore = exportDB.taboo_data;

    var zipWriter = Cc["@mozilla.org/zipwriter;1"]
                    .createInstance(Ci.nsIZipWriter);

    zipWriter.open(aFile, PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE);

    var results = this._store.find(["deleted IS NULL"]);

    for each (var result in results) {
      var entry = exportStore.new();
      for (var field in this._schema) {
        entry[field] = result[field];
      }
      entry.full = cleanTabState(result.full, true);
      entry.save();

      var imageFile = this._getImageFile(result.md5);
      zipWriter.addEntryFile(imageFile.leafName,
                             Ci.nsIZipWriter.COMPRESSION_NONE,
                             imageFile, true);

      var thumbFile = this._getThumbFile(result.md5);
      zipWriter.addEntryFile(thumbFile.leafName,
                             Ci.nsIZipWriter.COMPRESSION_NONE,
                             thumbFile, true);
    }

    exportDB.close();

    zipWriter.addEntryFile(TABOO_EXPORT_DB_FILENAME,
                           Ci.nsIZipWriter.COMPRESSION_NONE,
                           dbfile, true);

    var obs = {
      onStartRequest: function() {},
      onStopRequest: function() {
        zipWriter.close();
        dbfile.remove(false);
      }
    };
    zipWriter.processQueue(obs, null);

    return results.length;
  },
  exportAsHTML: function TSSQL_exportAsHTML(aFile) {
    var data = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n';
    data += '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; ' +
            'charset=UTF-8">\n';
    data += '<TITLE>Bookmarks</TITLE>\n';
    data += '<H1>Bookmarks</H1>\n';
    data += '<DL><p>\n';

    var results = this._store.find(["deleted IS NULL"]);

    for each (var result in results) {
      var entry = '    <DT><A HREF="' + result.url + '"';

      if (result.favicon) {
        entry += ' ICON="' + result.favicon + '"';
      }

      entry += '>';

      if (result.title) {
        entry += result.title
      }

      entry += '</A>\n';

      if (result.description) {
        entry += '<DD>' + result.description + '\n';
      }

      data += entry;
    }

    data += '</DL><p>';

    var ostream = Cc['@mozilla.org/network/file-output-stream;1']
      .createInstance(Ci.nsIFileOutputStream);
    ostream.init(aFile, PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE, 0600, 0);

    var converter = Cc['@mozilla.org/intl/scriptableunicodeconverter']
      .createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = 'UTF-8';

    var convdata = converter.ConvertFromUnicode(data) + converter.Finish();

    ostream.write(convdata, convdata.length);

    ostream.flush();
    ostream.close();

    return results.length;
  },
  _getImageFile: function TSSQL__getImageFile(id) {
    var file = this._tabooDir.clone();
    file.append(id + '.png');
    return file;
  },
  _getThumbFile: function TSSQL__getPreviewFile(id) {
    var file = this._tabooDir.clone();
    file.append(id + '-' + IMAGE_THUMB_WIDTH + '.png');
    return file;
  },
  _saveImage: function TSSQL__saveImage(imageData, file) {
    try {
      file.remove(false);
    }
    catch (e) { }

    try {
      var ostream = Cc['@mozilla.org/network/file-output-stream;1']
        .createInstance(Ci.nsIFileOutputStream);
      ostream.init(file, PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE, 0600, 0);

      ostream.write(imageData, imageData.length);
      ostream.close();
    }
    catch (e) { }
  },
  _deleteOp: function TSSQL__deleteOp(url, deleted) {
    var entry = this._store.find(url);
    if (entry) {
      entry.deleted = deleted;
      entry.save();
    }
  },
  _loadDB: function TSSQL__loadDB(aDBFile) {
    Cu.import("resource://taboo/sqlite.js");
    var db = new SQLiteDB(aDBFile);
    db.Table('taboo_data', this._schema);
    return db;
  }
}

function TabooService() {
  this._observers = [];

  var obs = getObserverService();
  obs.addObserver(this, 'profile-after-change', false);
}

TabooService.prototype = {
  _init: function TB__init() {
    this._storage = new TabooStorageSQL();
  },
  observe: function TB_observe(subject, topic, state) {
    var obs = getObserverService();

    switch (topic) {
      case 'profile-after-change':
        obs.removeObserver(this, 'profile-after-change');
        this._init();
        break;
    }
  },

  addObserver: function TB_addObserver(aObserver) {
    if (this._observers.indexOf(aObserver) == -1) {
      this._observers.push(aObserver);
    }
  },
  removeObserver: function TB_removeObserver(aObserver) {
    var index = this._observers.indexOf(aObserver);
    if (index != -1) {
      this._observers.splice(index, 1);
    }
  },

  saveAll: function TB_saveAll() {
    var wm = Cc["@mozilla.org/appshell/window-mediator;1"]
      .getService(Ci.nsIWindowMediator);
    var win = wm.getMostRecentWindow('navigator:browser');

    var ss = Cc['@mozilla.org/browser/sessionstore;1']
      .getService(Ci.nsISessionStore);

    var winJSON = "(" + ss.getWindowState(win) + ")";

    if (getBoolPref(PREF_DEBUG, false))
      dump(winJSON + "\n");

    var sandbox = new Cu.Sandbox('about:blank');
    var winState = Cu.evalInSandbox(winJSON, sandbox);
    var tabStates = winState.windows[0].tabs;

    var tabbrowser = win.getBrowser();

    var tabs = tabbrowser.tabContainer.childNodes;
    var browsers = tabbrowser.browsers;
    for (var i = 0; i < browsers.length; i++) {
      var tab = tabs[i];
      var tabWin = browsers[i].contentWindow;
      var state = tabStates[i];
      this._saveTab(state, tabWin, tab, null);
    }

    return true;
  },
  save: function TB_save(aDescription) {
    var wm = Cc["@mozilla.org/appshell/window-mediator;1"]
      .getService(Ci.nsIWindowMediator);
    var win = wm.getMostRecentWindow('navigator:browser');

    var tabbrowser = win.getBrowser();
    var selectedBrowser = tabbrowser.selectedBrowser;
    var selectedTab = tabbrowser.selectedTab;

    var currentTab = -1;
    var browsers = tabbrowser.browsers;
    for (var i = 0; i < browsers.length; i++) {
      if (browsers[i] == selectedBrowser)
        currentTab = i;
    }

    if (currentTab == -1)
      return false;

    var ss = Cc['@mozilla.org/browser/sessionstore;1']
      .getService(Ci.nsISessionStore);

    var tabJSON = "(" + ss.getTabState(selectedTab) + ")";

    if (getBoolPref(PREF_DEBUG, false))
      dump(tabJSON + "\n");

    var sandbox = new Cu.Sandbox('about:blank');
    var state = Cu.evalInSandbox(tabJSON, sandbox);

    return this._saveTab(state, win.content, selectedTab, aDescription);
  },
  _saveTab: function TB__saveTab(aState, aWindow, aTab, aDescription) {
    var url = aState.entries[aState.index - 1].url;
    url = url.replace(/#.*$/, '');

    var fullImage = snapshot(aWindow, IMAGE_FULL_WIDTH, IMAGE_FULL_HEIGHT);
    var thumbImage = snapshot(aWindow, IMAGE_THUMB_WIDTH, IMAGE_THUMB_HEIGHT);

    var exists = this._storage.save(url, aDescription, aState,
                                    fullImage, thumbImage);

    var faviconURL = aTab.getAttribute('image');
    if (faviconURL) {
      var ios = Cc['@mozilla.org/network/io-service;1']
        .getService(Ci.nsIIOService);
      var faviconURI = ios.newURI(faviconURL, null, null);

      var faviconSvc = Cc['@mozilla.org/browser/favicon-service;1']
        .getService(Ci.nsIFaviconService);

      var dataURL = null;

      try {
        if (faviconSvc.getFaviconDataAsDataURL) {
          dataURL = faviconSvc.getFaviconDataAsDataURL(faviconURI);
        } else {
          var mimeType = {};
          var bytes = faviconSvc.getFaviconData(faviconURI, mimeType, {});
          if (bytes) {
            dataURL = 'data:';
            dataURL += mimeType.value;
            dataURL += ';base64,';
            dataURL += btoa(String.fromCharCode.apply(null, bytes));
          }
        }
      } catch (ex) {
        // do nothing, use default value
      }

      if (dataURL) {
        this._storage.saveFavicon(url, dataURL);
      }
    }

    for (var i = 0; i < this._observers.length; i++) {
      this._observers[i].onSave(url, !exists);
    }

    return true;
  },
  isSaved: function TB_isSaved(aURL) {
    return this._storage.exists(aURL);
  },
  update: function TB_update(aURL, aTitle, aDescription) {
    var valid = this._storage.update(aURL, aTitle, aDescription);
    if (!valid) {
      throw 'Taboo for ' + aURL + ' does not exist';
    }
  },
  'delete': function TB_delete(aURL) {
    this._storage.delete(aURL);

    for (var i = 0; i < this._observers.length; i++) {
      this._observers[i].onDelete(aURL);
    }
  },
  undelete: function TB_undelete(aURL) {
    this._storage.undelete(aURL);

    for (var i = 0; i < this._observers.length; i++) {
      this._observers[i].onUndelete(aURL);
    }
  },
  reallyDelete: function TB_reallyDelete(aURL) {
    this._storage.reallyDelete(aURL);

    for (var i = 0; i < this._observers.length; i++) {
      this._observers[i].onReallyDelete(aURL);
    }
  },
  get: function TB_get(filter, deleted) {
    return this._tabEnumerator(this._storage.getURLs(filter, deleted, -1));
  },
  getRecent: function TB_getRecent(aMaxRecent) {
    return this._tabEnumerator(this._storage.getURLs(null, false, aMaxRecent));
  },
  getForURL: function TB_getForURL(aURL) {
    return this._storage.retrieve(aURL);
  },

  import: function TB_import(aFile) {
    var numImported = this._storage.import(aFile);

    // FIXME: Call observers on each url imported
    for (var i = 0; i < this._observers.length; i++) {
      this._observers[i].onSave(null, false);
    }

    return numImported;
  },
  export: function TB_export(aFile) {
    return this._storage.export(aFile);
  },
  exportAsHTML: function TB_exportAsHTML(aFile) {
    return this._storage.exportAsHTML(aFile);
  },

  _tabEnumerator: function TB__tabEnumerator(aURLs) {
    return {
      _urls: aURLs,
      _storage: this._storage,
      getNext: function() {
        var url = this._urls.shift();
        return this._storage.retrieve(url);
      },
      hasMoreElements: function() {
        return this._urls.length > 0;
      }
    }
  },

  open: function TB_open(aURL, aWhere) {
    var wm = Cc['@mozilla.org/appshell/window-mediator;1']
      .getService(Ci.nsIWindowMediator);
    var win = wm.getMostRecentWindow('navigator:browser');

    var loadInBackground = getBoolPref("browser.tabs.loadInBackground", true);

    if (aWhere == 'tabforeground') {
      loadInBackground = false;
      aWhere = 'tab';
    }

    if (aWhere == 'tabbackground') {
      loadInBackground = true;
      aWhere = 'tab';
    }

    var tabbrowser = win.getBrowser();

    var tab;
    switch (aWhere) {
      case 'current':
        tab = tabbrowser.mCurrentTab;
        break;
      case 'tabshifted':
        loadInBackground = !loadInBackground;
        // fall through
      case 'tab':
        tab = tabbrowser.loadOneTab('about:blank', null, null, null,
                                    loadInBackground, false);
        break;
      default:
        return;
    }

    this.openInTab(aURL, tab);
  },

  openInTab: function TB_openInTab(aURL, aTab) {
    var info = this._storage.retrieve(aURL);
    if (!info) {
      throw 'Taboo for ' + aURL + ' does not exist';
    }

    var tabData = info.data;

    var ss = Cc['@mozilla.org/browser/sessionstore;1']
             .getService(Ci.nsISessionStore);
    ss.setTabState(aTab, tabData);
  },

  getInterfaces: function TB_getInterfaces(countRef) {
    var interfaces = [Ci.oyITaboo, Ci.nsIObserver, Ci.nsISupports];
    countRef.value = interfaces.length;
    return interfaces;
  },
  getHelperForLanguage: function TB_getHelperForLanguage(language) null,
  contractID: TB_CONTRACTID,
  classDescription: TB_CLASSNAME,
  classID: TB_CLASSID,
  implementationLanguage: Ci.nsIProgrammingLanguage.JAVASCRIPT,
  flags: Ci.nsIClassInfo.SINGLETON,
  _xpcom_categories: [{ category: 'app-startup', service: true }],
  QueryInterface: XPCOMUtils.generateQI([Ci.oyITaboo, Ci.nsIObserver,
                                         Ci.nsIClassInfo])
}

function NSGetModule(compMgr, fileSpec)
  XPCOMUtils.generateModule([TabooService]);
