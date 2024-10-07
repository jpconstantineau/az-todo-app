import pkgfn from '@azure/functions';

const { app, HttpResponse, input, output } = pkgfn;

const sendToCosmosDb = output.cosmosDB({
    databaseName: 'ToToList',
    containerName: 'Items',
    createIfNotExists: false,
    connection: 'CosmosDbConnectionSetting',
  });

const cosmosInputItem = input.cosmosDB({
    databaseName: 'ToDoList',
    containerName: 'Items',
    sqlQuery: 'SELECT * FROM c WHERE c.UserID = {UserID} AND c.ObjectType = {ObjectType} AND c.ObjectID = {ObjectID}',
    connection: 'CosmosDbConnectionSetting'
});

const cosmosInputList = input.cosmosDB({
    databaseName: 'ToDoList',
    containerName: 'Items',
    sqlQuery: 'SELECT * FROM c WHERE c.UserID = {UserID} AND c.ObjectType = {ObjectType}',
    connection: 'CosmosDbConnectionSetting'
});

app.http('item', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'item/{UserID:minlength(4)}/{ObjectType:minlength(4)}/{ObjectID:minlength(4)}',
    extraInputs: [cosmosInputItem,cosmosInputList],
    extraOutputs: [sendToCosmosDb],
    handler: (request, context) => {

        const UserID = request.params.UserID
        const ObjectType = request.params.ObjectType
        const ObjectID = request.params.ObjectID

        // GET AUTH DETAILS
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

        // CHECK AUTH DETAILS
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
        var objectsFromDB
        var htmldata = ''
        // PROCESS REQUEST
        switch (ObjectID)
        {
            
            case "list": // list all objects of type "ObjectType"
                    try
                    {
                        objectsFromDB = context.extraInputs.get(cosmosInputList);
                    }
                    catch(err)
                    {
                        context.log(`500 error on object.identityProvider from cosmosInput:"${request.url}"`);
                        return {
                            status: 500,
                            body: '500 error on object.identityProvider from cosmosInput'
                        };
                    }       
                    htmldata = htmldata + `<div>
                    <div hx-target="this" hx-swap="outerHTML" ><button hx-get="/api/item/`+UserID+`/`+ObjectType+`/create">Add New</button></div>
                    <table>`      
                    for (const object of objectsFromDB) 
                        {
                            htmldata = htmldata + `<tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.type+`</td></tr>`
                        }
                    htmldata = htmldata + `</table>
                    </div>`
                    

                    return {
                        status: 200,
                        body: htmldata,
                    };
                break
            case "create": // return form needed to create object 
                    var id = Date.now()
                    htmldata = htmldata + `
                    <form hx-post="/api/item/`+UserID+`/`+ObjectType+`/`+id+`" hx-target="this" hx-swap="outerHTML">
                        <div>
                            <label>Name</label>
                            <input type="text" name="name" value="name">
                        </div>
                        <div class="form-group">
                            <label>Type</label>
                            <input type="text" name="type" value="type">
                        </div>
                        <button class="btn">Submit</button>
                        <button class="btn" hx-get="/contact/1">Cancel</button>
                    </form>`    

                    return {
                        status: 200,
                        body: htmldata,
                    };
                break
            default: 
                switch (request.method)
                {
                    case "DELETE": // Delete Object
                        // get object
                        // update ttl to 1
                        // save object
                        break
                    case "POST": // Create/Update Object
                            /* let item = {}
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
                    default:     
                        
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
            
                        var founddata = false
                        for (const object of objectsFromDB) {founddata=true}
            
                            if (!founddata) {
                                return {
                                    status: 404,
                                    body: 'item not found',
                                };
                            } 
                            else
                            {
                                var response = new HttpResponse({ status: 200, 
                                    body: JSON.stringify(objectsFromDB)
                                });
                                response.headers.set('content-type', 'application/json');
                                return response;                                                
                            }

                }   
        }

        // IF NO CASE IS FOUND
        return {
            status: 200,
            body: 'Nothing done'
        };
    }
});