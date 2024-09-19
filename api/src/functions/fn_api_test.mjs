import pkg from '@azure/functions';
const { app, HttpResponse } = pkg;

app.http('test_start', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'test_start',
    handler: async (request, context) => {
       
        context.log(`Http function processed request for url "${request.url}"`);
        context.log(`Invocation ID: "${context.invocationId}"`);       
        context.log(`Http headers "${JSON.stringify(request.headers)}"`);
        const data = `
        <!doctype html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>functions</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-T3c6CoIi6uLrA9TneNEoa7RxnatzjcDSCmG1MXxSR1GAsXEV/Dwwykc2MPK8M2HN" crossorigin="anonymous">
        </head>
        <body>
            <h1>To Do</h1>
            <div hx-get="/api/get_list" hx-trigger="load">
                loading...
            </div>
        </body>
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js" integrity="sha384-C6RzsynM9kWDrMNeT87bh95OGNyZPhcTNXj1NW7RuBCsyN/o0jlpcV8Qyq46cDfL" crossorigin="anonymous"></script>
        <script src="https://unpkg.com/htmx.org@2.0.2"></script>
        </html>
        `;

        const response = new HttpResponse({ status: 200, 
            body: data
        });
        response.headers.set('content-type', 'text/html; charset=utf-8');

        return response;
            
    }
});
