import pkgfn from '@azure/functions';

const { app, HttpResponse, input, output } = pkgfn;


const sendToCosmosDb = output.cosmosDB({
    databaseName: 'ToDoList',
    containerName: 'Items',
    createIfNotExists: false,
    connection: 'CosmosDbConnectionSetting',
  });


app.http('user', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);
        
        let object= {}
        try
        {
            const header = request.headers.get('x-ms-client-principal');
            const encoded = Buffer.from(header, 'base64');
            let decoded = encoded.toString('ascii');
            object= JSON.parse(decoded)
        }
        catch(err)
        {
            context.log(`500 error on get query"${request.url}" header parse`);
            object.errordetails = err.message
        }

   
        try
        {
            switch (object.identityProvider)
            {
                case "github":
                    //https://avatars.githubusercontent.com/jpconstantineau?size=40
                    //
                    break;  
                }

        }
        catch(err)
        {
            context.log(`500 error on get user from cosmosdb"${request.url}"`);
            object.errordetails = err.message
        }
     
        return { 
          body: JSON.stringify(object)    
         };
    }
});