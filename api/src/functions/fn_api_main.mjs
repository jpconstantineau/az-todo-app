import pkgfn from '@azure/functions';
import CheckUsers from "./auth/CheckUsers.mjs";

const { app, HttpResponse, input} = pkgfn;

app.http('main', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'main/main',
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);
        var chk = new CheckUsers()
        var userdetails = chk.GetUserDetails(request)
           
        var htmldatastart = ``
        var data = ``
        var htmldataend = `<article class = "container" id="mainarea"></article> 
                           <article class = "container" id="statusarea"></article>
                           <article class = "container" id="errorarea"></article>`

        if (userdetails.authorized)
        {
          const userid = userdetails.userId 
          const listid = "listid"
          // lists will be dynamic from configured lists for user logged in
            data = `
            <article>
            <aside>
                <nav > 
                      <ul id="navlist">
                        <li hx-get="/api/item/`+userid+`/object.list/menu" hx-trigger="load" hx-swap="outerHTML">List Menu</li>
                      </ul> 
            </aside>
            </article>
            `
        }
        else
        {
            data = `
            <aside>
                <nav>
                <ul>
                  <li><a href="/login">Login: <i class="fa-brands fa-github"></i></a></li>
                </ul>
                </nav>
            </aside>`
        }
        return { 
          body: htmldatastart + data + htmldataend     
         };
    }
});

app.http('mainconfig', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'main/config',
  handler: async (request, context) => {
      context.log(`Http function processed request for url "${request.url}"`);
      var chk = new CheckUsers()
      var userdetails = chk.GetUserDetails(request)
         
      var data = ``

        const userid = userdetails.userId 
        // lists will be dynamic from configured lists for user logged in
          data = `      <li hx-get="/api/item/`+userid+`/object.type/menu" hx-trigger="load" hx-swap="outerHTML">Object Menu</li>
                        <li hx-get="/api/item/`+userid+`/object.list/list" hx-target="#mainarea">Lists</li>
                        <li hx-get="/api/item/`+userid+`/object.type/list" hx-target="#mainarea">Input Objects</li>
                        <li hx-get="/api/item/`+userid+`/input.type/list" hx-target="#mainarea">Input Types</li>`
      return { 
        body:  data      
       };
  }
});

app.http('mainmenu', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'main/menu',
  handler: async (request, context) => {
      context.log(`Http function processed request for url "${request.url}"`);
      var chk = new CheckUsers()
      var userdetails = chk.GetUserDetails(request)
         
        const userid = userdetails.userId 
        // lists will be dynamic from configured lists for user logged in
          
          return { 
        body:  `<li hx-get="/api/item/`+userid+`/object.list/menu" hx-trigger="load" hx-swap="outerHTML">List Menu</li>`     
       };
  }
});