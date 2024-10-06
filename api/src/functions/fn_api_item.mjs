import pkgfn from '@azure/functions';

const { app, HttpResponse, input, output } = pkgfn;

const sendToCosmosDb = output.cosmosDB({
    databaseName: 'ToToList',
    containerName: 'Items',
    createIfNotExists: false,
    connection: 'CosmosDbConnectionSetting',
  });

const cosmosInput = input.cosmosDB({
    databaseName: 'ToDoList',
    containerName: 'Items',
    sqlQuery: 'SELECT * FROM c WHERE c.UserID = {UserID} AND c.ObjectType = {ObjectType} AND c.ObjectID = {ObjectID}',
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
            context.log(`500 error on object.identityProvider from x-ms-client-principal:"${request.url}"`);
            return {
                status: 500,
                body: 'error with identityProvider',
            };

        }
     
        if (request.method === 'POST')
        {
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
        }
        if (request.method === 'GET')
        {
            var objectsFromDB
            try
            {
                objectsFromDB = context.extraInputs.get(cosmosInput);
            }
            catch(err)
            {
                context.log(`500 error on object.identityProvider from cosmosInput:"${request.url}"`);
                return {
                    status: 500,
                    body: '500 error on object.identityProvider from cosmosInput'
                };
            }
          //  try
           // {
                if (objectsFromDB.length()==0) {
                    return {
                        status: 404,
                        body: 'item not found',
                    };
                } 
                else
                {
                    response = new HttpResponse({ status: 200, 
                        body: JSON.stringify(objectsFromDB)
                    });
                    response.headers.set('content-type', 'application/json');
                    return response;                                                
                }
        //    }
           /* catch (err){
                return {
                    status: 500,
                    body: '500 error on objectsFromDB.length()'
                };
            }*/

        } 
    
        return {
            status: 200,
            body: 'Nothing done'
        };
    }
});