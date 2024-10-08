import pkgfn from '@azure/functions';

const { app, HttpResponse, input, output } = pkgfn;

const sendToCosmosDb = output.cosmosDB({
    databaseName: 'ToDoList',
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
    handler: async (request, context) => {

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
                    switch(ObjectType)
                    {
                        case "input.type":
                                htmldata = htmldata + `<div>
                                <table>`      
                                for (const object of objectsFromDB) 
                                    {
                                        htmldata = htmldata + `<tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.data.type+`</td></tr>`
                                    }
                                htmldata = htmldata + `</table>
                                </div>`            
                            break
                        case "object.typea":
                                htmldata = htmldata + `<div>
                                <table>`      
                                for (const object of objectsFromDB) 
                                    {
                                        htmldata = htmldata + `<tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.data.type+`</td></tr>`
                                    }
                                htmldata = htmldata + `</table>
                                </div>`            
                            break
                        case "object.lista":
                                htmldata = htmldata + `<div>
                                <table>`      
                                for (const object of objectsFromDB) 
                                    {
                                        htmldata = htmldata + `<tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.data.type+`</td></tr>`
                                    }
                                htmldata = htmldata + `</table>
                                </div>`            
                        default:
                                htmldata = htmldata + `<div>
                                <div hx-target="this" hx-swap="outerHTML" ><button hx-get="/api/item/`+UserID+`/`+ObjectType+`/create">Add New</button></div>
                                <table id="tablelist">`      
                                for (const object of objectsFromDB) 
                                    {
                                        htmldata = htmldata + `<tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.data.type+`</td></tr>`
                                    }
                                htmldata = htmldata + `</table>`    
                        }
                    
                    return {
                        status: 200,
                        body: htmldata,
                    };
                break
            
            case "menu":
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
                    htmldata = htmldata + ``      
                    for (const object of objectsFromDB) 
                        {
                            htmldata = htmldata + `<li hx-get="/api/item/`+object.UserID+`/`+object.ObjectType+`/list" hx-target="#mainarea">`+object.data.name+`</li>`
                        }
                    htmldata = htmldata + ``
                    

                    return {
                        status: 200,
                        body: htmldata,
                    };
                break    
            case "create": // return form needed to create object 
                    var id = Date.now()
                    htmldata = htmldata + `
                    <div hx-target="this" hx-swap="outerHTML" ><button hx-get="/api/item/`+UserID+`/`+ObjectType+`/create">Add New</button></div>
                    <form hx-post="/api/item/`+UserID+`/`+ObjectType+`/`+id+`" hx-target="this" hx-swap="outerHTML">
                        
                            <label>Name</label>
                            <input type="text" name="name" value="name">
                            <label>Type</label>
                            <input type="text" name="type" value="type">
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
                             var item = {}
                                var fd = await request.formData();
                                fd.forEach((value, key) => item[key] = value);   
                                var dataobject =   {
                                    id: ObjectID,
                                    UserID: UserID,
                                    ObjectType: ObjectType,
                                    ObjectID: ObjectID,
                                    name: item.name,
                                    data: item
                                }
                
                                try {
                                    context.extraOutputs.set(sendToCosmosDb, dataobject);  
                                    return {
                                        status: 200,
                                        body:  `<table hx-swap-oob="beforeend:#tablelist >
                                                    <tr><td>`+dataobject.id+`</td><td>`+dataobject.name+`</td><td>`+dataobject.data.type+`</td></tr> 
                                                </table>`

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
                        for (const object of objectsFromDB) 
                            {
                                founddata=true
                                htmldata = htmldata + `
                                <div hx-target="this" hx-swap="outerHTML" ><button hx-get="/api/item/`+UserID+`/`+ObjectType+`/create">Add New</button></div>
                                <div id="alerts" hx-swap-oob="true">
                                    <tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.data.type+`</td></tr>
                                </div>`
                                
                                
                            }
            
                            if (!founddata) {
                                return {
                                    status: 404,
                                    body: 'item not found',
                                };
                            } 
                            else
                            {
                                var response = new HttpResponse({ status: 200, 
                                    body: htmldata
                                });
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