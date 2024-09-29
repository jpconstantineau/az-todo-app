import pkg from '@azure/functions';
const { app, HttpResponse } = pkg;


app.http('footer', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'main/footer',
    handler: async (request, context) => {
       
        context.log(`Http function processed request for url "${request.url}"`);
        context.log(`Invocation ID: "${context.invocationId}"`);       
        context.log(`Http headers "${JSON.stringify(request.headers)}"`);
        const username = "jpconstantineau"
        const data = `
        <small>Built with <a href="https://picocss.com">Pico</a>
        <a href="https://github.com/picocss/examples/blob/master/v2-html-classless/index.html">Source code</a>
        </small>

        <img src="https://avatars.githubusercontent.com/` + username + `?size=40" alt="` + username + `" class="circular-square">
        `;

        const response = new HttpResponse({ status: 200, 
            body: data
        });
        response.headers.set('content-type', 'text/html; charset=utf-8');

        return response;
            
    }
});
