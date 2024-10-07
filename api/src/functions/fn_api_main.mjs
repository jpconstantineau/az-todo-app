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
                <nav> 
                  <details>
                    <summary>Lists</summary>
                    <ul>
                      <li hx-get="/api/list/`+userid+`/`+listid+`" hx-target="#mainarea">To Do</li>
                      <li hx-get="/api/list/`+userid+`/`+listid+`" hx-target="#mainarea">Shopping</li>
                      <li hx-get="/api/list/`+userid+`/`+listid+`" hx-target="#mainarea">Work</li>
                    </ul> 
                  </details>
                  <details>
                    <summary>Config</summary>
                    <ul>
                      <li hx-get="/api/item/`+userid+`/object.types/list" hx-target="#mainarea">Object Types</li>
                      <li hx-get="/api/config/`+userid+`/lists/`+listid+`" hx-target="#mainarea">Lists</li>
                      <li hx-get="/api/item/`+userid+`/groups/`+listid+`" hx-target="#mainarea">Groups</li>
                    </ul> 
                  </details>
                  </nav>
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