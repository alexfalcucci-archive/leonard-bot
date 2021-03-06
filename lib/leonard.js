'use strict';

var xmppClient = require('node-xmpp-client');
var Stanza = xmppClient.Stanza;
var Message = require('./message');
var Plugin = require('./plugins');
var PLUGINS = Plugin._plugins;
/**
 * Leonard is the hipchat bot. Instantiate him with a JSON object
 * containing his jabber id and password at minimum.
 *
 * @param options
 *        jid: required - jabber id
 *        password: required - jabber password
 *        apiTokenV2: optional - hipchat api v2 token
 *        host - optional - the hipchat server host (default: chat.hipchat.com)
 *        port - optional - the hipchat server port (default: 5222)
 */
function Leonard(options){
  this.users = {};
  this.mentionHandlers = [];
  this.messageHandlers = [];

  console.log("Loading plugins...");

  //if pluginDir was specified, load in the plugins
  if (options.pluginDir) {
    this._loadPlugins(options.pluginDir);
  }

  for (var k in PLUGINS) {
    var plugin = PLUGINS[k];
    this.mentionHandlers = this.mentionHandlers.concat(plugin.mentionHandlers);
    this.messageHandlers = this.messageHandlers.concat(plugin.messageHandlers);
    console.log("Loaded Plugin: " + k);

  }

  console.log("Loading options...");

  this.options = options||{};
  options.fullJid = this.options.jid+"/bot";

  var requiredOptions = ['jid','password'];
  for (var i in requiredOptions){
    var key = requiredOptions[i];
    if (!options[key]){
      throw new Error("Missing required option: " + key);
    }
  }

  console.log("Negotiating session...");
  //setup the options for the xmpp client
  var clientOptions = {
    jid: options.fullJid,
    password: options.password,
  };

  if (!options.host){
    options.host = options.jid.split("@")[1];
  }

  clientOptions.host = options.host;
  clientOptions.port = options.port||5222;


  //instantiate an XMPP client
  this.client = new xmppClient(clientOptions);

  console.log("Starting Leonard...")
  //initialize Leonard
  this._init();
}

Leonard.prototype._loadPlugins = function(dir){
  var mainFile = require.main.filename;
  var entryDir = mainFile.substr(0,mainFile.lastIndexOf("/"));
  var fs = require('fs');
  var files = fs.readdirSync(dir);
  for (var file of files) {
    if (file.substr(file.length-3).toLowerCase() === ".js"){
      require(entryDir+"/"+dir+"/"+file.substr(0,file.length-3));
    }
  }
}

/**
 * this initializes the client and makes the required calls to get the profile information as well as the info
 * required to join rooms.
 */
Leonard.prototype._init = function(){
  var self = this;

  //set the online handler
  this.client.on("online", function(){

    //set to available
    self.client.send(new Stanza("presence", {
      type: 'available'
    }).c("show").t("chat"));

    //set an interval of 60 seconds to send a packet with just " " as the content as per
    //hipchat guidelines
    setInterval(function(){
      var timeout = self.options.timeoutInterval || 60000;
      self.client.connection.socket.write(" ");
    }, 60*1000);

    self._startup();
  });

  this.client.on("error", function(s){
    //print out all client errors
    console.log(s.toString());
  })

  this.client.on("stanza", function(stanza){
    if (stanza.is("iq") && stanza.attrs.type === "result"){
      self._handleIQResult(stanza);
    } else if (stanza.attrs.type == "error"){
      //just print out the stanza
      console.log(stanza.toString())
    } else if (stanza.is("message") && stanza.getAttr("type") === "groupchat"){
      var message = Message.fromStanza(stanza);
      if (!message.body || message.sender == self.options.jid){
        return;
      }
      for (var handler of self.messageHandlers){
        var match = handler.re.exec(message.body);
        if (match) {
          //if it matches then do the handler callback
          try{
            var captures = match.splice(1);//This variable is for clarity. Don't remove
            handler.cb(self, message, captures);
          } catch(e) {
            if (handler.plugin) {
              console.log("Plugin '" + handler.plugin + "' had encountered an error (matching '"+ handler.re +"'): ");
              console.log(e.stack);
            } else{
              console.log("Encountered an error: ");
              console.log(e.stack);
            }
          }
        }
      }
      //go through our internal list of regex. send the
      if (self.mentionRegex.test(message.body)){
        //if this is a mention we also will go through the mention handlers as well.
        for (var handler of self.mentionHandlers){
          var match = handler.re.exec(message.body);
          if (match){
            //if it matches then do the handler callback
            try{
              var captures = match.splice(1);//This variable is for clarity. Don't remove
              handler.cb(self, message, captures);
            } catch(e) {
              if (handler.plugin) {
                console.log("Plugin '" + handler.plugin + "' had encountered an error (matching '"+ handler.re +"'): ");
                console.log(e.stack);
              } else{
                console.log("Encountered an error: ");
                console.log(e.stack);
              }
            }
          }
        }
      }
    } else if (stanza.is("presence") && stanza.getChildByAttr("xmlns",'http://jabber.org/protocol/muc#user')) {
      self._handleUserPresence(stanza);
    }
  })
};

/**
 * ************************************
 * 	PUBLIC API
 * ************************************
 */

/**
 * Send accepts a Message object and marshals it using the XMPP
 * protocol.
 * @param message: the message object to be sent
 */
Leonard.prototype.send = function(message){
  if (message.to){
    //if a reply, then add the mention
    message.body = "@"+this.users[message.to].mentionName+" "+message.body
  }
  //create a message stanza
  var s = new Stanza("message", {
    from: this.fullJid,
    to: message.room,
    type: "groupchat"})
  s.c("body").t(message.body);
  this.client.send(s);
}


/**
 * onMessage takes a regex param and a callback function and registers the function to be called upon receiving a
 * message which satisfies the regex.
 * @param  regex: the regex object to use in testing against messages
 * @param  callback: the callback which will be called upon receiving a message satisfying that regex.
 *                   Should have the signature `function(client, message, captures){}`
 */
Leonard.prototype.onMessage = function(regex, callback){
  const regexWithoutModifiers = regex.toString().split('/');
  regexWithoutModifiers.shift();
  const modifiers = regexWithoutModifiers.pop();
  const pattern = regexWithoutModifiers.join('/');
  this.messageHandlers.push({re: new RegExp(pattern, modifiers), cb: callback});
}

/**
* onMention takes a regex param and a callback function and registers the function to be called upon receiving a mention
* message which satisfies the regex.
* @param  regex: the regex object to use in testing against messages
* @param  callback: the callback which will be called upon receiving a message satisfying that regex
*                   Should have the signature `function(client, message, captures){}`
*/
Leonard.prototype.onMention = function(regex, callback){
  const regexWithoutModifiers = regex.toString().split('/');
  regexWithoutModifiers.shift();
  const modifiers = regexWithoutModifiers.pop();
  const pattern = regexWithoutModifiers.join('/');
  this.mentionHandlers.push({re: new RegExp(pattern, modifiers), cb: callback});
}

/**
* ************************************
* 	PRIVATE API
* ************************************
*/

/**
 * This function sends a discovery for the bot's own profile so we get the reserved nickname for the bot's jabber
 * account
 */
Leonard.prototype._startup = function(){
  var s = new Stanza("iq", {
    type: 'get',
    id: 'startup',
  }).c('query', {xmlns: "http://hipchat.com/protocol/startup", send_auto_join_user_presences: 'false'})
  this.client.send(s);
}

//sends a roomlist request to the server. Just to keep things organized, call this after startup
Leonard.prototype._getRooms = function(){
  console.log("Getting room list...")
  //use the room discovery protocol as per hipchat's docs
  var s = new Stanza("iq", {
    to:   'conf.hipchat.com',
    id:   'rooms',
    type: 'get'
  }).c("query", {
    xmlns:"http://jabber.org/protocol/disco#items",
    include_archived: false
  })

  this.client.send(s);
};

/**
 * This is the handle switch for the IQ results received from the server. At some point I'll move to using some kind of
 * callback handler
 */
Leonard.prototype._handleIQResult = function(stanza){
  //we switch based on id which we set for various IQ requests
  switch(stanza.attrs.id){
    case "rooms": // handle the roomlist
      //reset this.roomList
      this.roomList = {}
      //in this case, the second level children are the items. We want these
      //we will manually traverse to save some cpu :P
      for(var room of stanza.getChild("query").getChildren("item")){
        this.roomList[room.getAttr("jid")] = {
          name: room.getAttr("name"),
          id: room.getChild("x").getChildText("id")
        }
      }
      //now do the room joins
      this._joinRooms();
      break;
    case 'startup': // handle the startup response
      var profileChildren = stanza.getChild("query");
      //we can get the info here since the calls are simple and made only once
      this.nick = profileChildren.getChildText("name");//get our nickname
      this.mentionName = profileChildren.getChildText("mention_name");//get our mention name
      this.mentionRegex = new RegExp("@\\b"+this.mentionName+"\\b");//create our mention regex object

      //now continue the init process and get our room list
      this._getRooms();
      break;
    case 'userprofile':
      this._handlerUserProfile(stanza);
  }
}

/**
 * this function iterates either the provided autojoin room list, or the whole discovered room list, joining each room
 * provided.
 */
Leonard.prototype._joinRooms = function(){
  console.log("Joining rooms...")
  //setup the stanza template
  var s = new Stanza("presence",{
    xmlns: 'http://jabber.org/protocol/muc',
    from: this.options.fullJid
  }).c("x", {xmlns: 'http://jabber.org/protocol/muc'});

  //the rooms to join are either specified or default to all
  var rooms = this.options.joinRooms||Object.keys(this.roomList);
  //join all rooms
  for(var roomId of rooms){
    s.tree().attrs.to = roomId+"/"+this.nick;
    this.client.send(s);
  }
  console.log("Done! :)");
}
Leonard.prototype._handleUserPresence = function(stanza) {
    //if this is our own presence, we will ignore it
    if (stanza.getChild("x").getChildByAttr("code","110")){
      return;
    }

    var name = stanza.getAttr("from").split("/")[1];
    var userJID = stanza.getChild("x").getChild("item").getAttr("jid");
    this.users[userJID] = {
      "name": name,
      "jid": userJID
    };

    //send out an XMPP request for the user profile.
    //NOTE: when first joining a room or starting the bot or when a user changes
    //presence, this will result in a LOT of requests for user info. I'm not convinced this is something we should add
    //throttling for though. It's not a big deal.
    var s = new Stanza("iq", {
      type:"get",
      to: userJID,
      id: "userprofile"
    }).c("query", {
      xmlns: "http://hipchat.com/protocol/profile"
    });
    this.client.send(s);
}

Leonard.prototype._handlerUserProfile = function(stanza){
  //check if we do have information to parse
  if (stanza.getChild("query")){
    var jid = stanza.getAttr("from");
    var info = stanza.getChild("query"); //information encapsulator

    //For now we just get the mentionName, we don't really care about anything
    //else atm.
    this.users[jid].mentionName = info.getChildText("mention_name")
  }
}

module.exports = Leonard;
