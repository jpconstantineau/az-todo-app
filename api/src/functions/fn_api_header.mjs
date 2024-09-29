import pkg from '@azure/functions';
const { app, HttpResponse } = pkg;

app.http('header', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'main/header',
    handler: async (request, context) => {
       
        context.log(`Http function processed request for url "${request.url}"`);
        context.log(`Invocation ID: "${context.invocationId}"`);       
        context.log(`Http headers "${JSON.stringify(request.headers)}"`);

        const data = `
      <hgroup>
        <h1>To Do</h1>
      </hgroup>
      <nav>
        <ul>
          <li>
            <details class="dropdown">
              <summary role="button" class="secondary">Theme</summary>
              <ul>
                <li><a href="#" data-theme-switcher="auto">Auto</a></li>
                <li><a href="#" data-theme-switcher="light">Light</a></li>
                <li><a href="#" data-theme-switcher="dark">Dark</a></li>
              </ul>
            </details>
          </li>
          <li><button class="secondary"><a href="/login">Login</a></button></li>          
        </ul>
        
      </nav>
        <script src="main.js"></script>
        `;

        const response = new HttpResponse({ status: 200, 
            body: data
        });
        response.headers.set('content-type', 'text/html; charset=utf-8');

        return response;
            
    }
});
