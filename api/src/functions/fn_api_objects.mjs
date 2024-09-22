import pkgfn from '@azure/functions';

const { app, HttpResponse, input, output } = pkgfn;

const sendToCosmosDb = output.cosmosDB({
    databaseName: 'ToToList',
    containerName: 'Items',
    createIfNotExists: false,
    connection: 'CosmosDbConnectionSetting',
  });

const cosmosInput = input.cosmosDB({
    databaseName: 'ToToList',
    containerName: 'Items',
    UserID: '{UserID}',  // PartitionKey1
    ObjectType: '{ObjectType}',  // PartitionKey2
    ObjectID: '{ObjectID}',  // PartitionKey3
    connection: 'CosmosDbConnectionSetting'
});



app.http('item', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'item/{UserID:minlength(4)}/{ObjectType:minlength(4)}/{ObjectID:minlength(4)}',
    extraInputs: [cosmosInput],
  //  extraOutputs: [sendToCosmosDb],
    handler: (request, context) => {

        const UserID = request.params.UserID
        const ObjectType = request.params.ObjectType
        const ObjectID = request.params.ObjectID

        let object= {}
        try
        {
            const header = request.headers.get('x-ms-client-principal')
            const encoded = Buffer.from(header, 'base64')
            let decoded = encoded.toString('ascii')
            object= JSON.parse(decoded)
        }
        catch(err)
        {
            context.log(`401 or 500 error on get query"${request.url}" header parse`);
            return {
                status: 401,
                body: 'Not Authorized'
            }
        }


        try
        {
            switch (object.identityProvider)
            {
                case "github":
                    //https://avatars.githubusercontent.com/jpconstantineau?size=40
                    //

                    if (! (UserID == object.userId))
                    {
                        return {
                            status: 401,
                            body: 'Not Authorized',
                        };
    
                    }

                    break;
                default:
                    return {
                        status: 401,
                        body: 'Not Authorized',
                    };                 
                }

        }
        catch(err)
        {
            context.log(`500 error on object.identityProvider from cosmosdb"${request.url}"`);
            return {
                status: 500,
                body: 'error with identityProvider',
            };

        }
     

        switch(request.method)
        {
            case "POST":
             /*   let item = {}
                var fd = await request.formData();
                fd.forEach((value, key) => item[key] = value);    

                try {
                    context.extraOutputs.set(sendToCosmosDb, {
                        id: object.userDetails+`.`+ObjectType+`.`+ObjectID,
                        UserID: UserID,
                        ObjectType: ObjectType,
                        ObjectID: ObjectID,
                        data: item
                    });  
                    return {
                        status: 200,
                        body: "success"
                    };

                }
                catch(err)
                {
                    context.log(`500 error on get user from cosmosdb"${request.url}"`);
                    return {
                        status: 500,
                        body: err.message
                    };
                }        
*/
                break
            default: // GET
        /*        const toDoItem = context.extraInputs.get(cosmosInput);
                if (!toDoItem) {
                    return {
                        status: 404,
                        body: 'ToDo item not found',
                    };
                } else {
                    response = new HttpResponse({ status: 200, 
                        body: JSON.stringify(toDoItem)
                    });
                    response.headers.set('content-type', 'application/json');
                    return response;                                                
                }*/
        } 
    
        return {
            status: 200,
            body: 'Nothing done'
        };
    }
});