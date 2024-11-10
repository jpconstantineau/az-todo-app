import pkgfn from '@azure/functions';
import CheckUsers from "./auth/CheckUsers.mjs";

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

app.http('item_list', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'item/{UserID:minlength(4)}/{ObjectType:minlength(4)}/list',
    extraInputs: [cosmosInputList],
//    extraOutputs: [sendToCosmosDb],
    handler: async (request, context) => {
        const UserID = request.params.UserID      
        const ObjectType = request.params.ObjectType  

        var chk = new CheckUsers()
        var userdetails = chk.GetUserDetails(request)
        if (!(userdetails.userId == UserID))
        {
            return {
                status: 401,
                body: 'Not Authorized',
            };
        }
        var htmldata = `<div hx-target="this"><button hx-get="/api/item/`+UserID+`/`+ObjectType+`/create">Add New</button></div>`

        /*
        var objectsFromDB = context.extraInputs.get(cosmosInputList);
        htmldata = htmldata + `<div><table>`      
        
        for (const object of objectsFromDB) 
            {
                switch(ObjectType)
                {
                    case "input.type":                    
                            htmldata = htmldata + `<tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.data.type+`</td></tr>`
                        break
                    case "object.typea":
                            htmldata = htmldata + `<tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.data.type+`</td></tr>`
                        break
                    case "object.lista":
                            htmldata = htmldata + `<tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.data.type+`</td></tr>`
                        break
                    default:
                            htmldata = htmldata + `<tr id="row`+object.ObjectID+`"> 
                            <td>`+object.name+`</td>
                            <td>`+object.data.type+`</td>`
                            htmldata  = htmldata  + `<td><button type="button" class="btn btn-primary btn-sm"  
                            hx-delete="/api/item/`+UserID+`/`+ObjectType+`/`+ object.ObjectID+`/delete"
                            hx-target="#row`+object.ObjectID+`" 
                            hx-swap="outerHTML"
                            hx-confirm="Are you sure?">
                            <i class="fa-solid fa-trash"></i>
                            </button></td>`
                            htmldata  = htmldata  + `<td><button type="button" class="btn btn-secondary btn-sm"
                            hx-get="/api/item/`+UserID+`/`+ObjectType+`/`+ object.ObjectID+`/edit" 
                            hx-trigger="edit" 
                            hx-target="#row`+object.ObjectID+`" 
                            hx-swap="outerHTML" 
                            onClick="let editing = document.querySelector('.editing')
                                    if(editing) {
                                    Swal.fire({title: 'Already Editing',
                                                showCancelButton: true,
                                                confirmButtonText: 'Yep, Edit This Row!',
                                                text:'Hey!  You are already editing a row!  Do you want to cancel that edit and continue?'})
                                    .then((result) => {
                                            if(result.isConfirmed) {
                                            htmx.trigger(editing, 'cancel')
                                            htmx.trigger(this, 'edit')
                                            }
                                        })
                                    } else {
                                        htmx.trigger(this, 'edit')
                                    }">
                            <i class="fa-solid fa-pen"></i> 
                            </button></td>
                            </tr>`    
                }
                htmldata = htmldata + `</table>
                </div>`            
            } */   
        return {
            status: 200,
            body: htmldata 
        };
    } 
});

/*
app.http('item_delete', {
    methods: ['delete'],
    authLevel: 'anonymous',
    extraInputs: [cosmosInputItem],
    extraOutputs: [sendToCosmosDb],
    route: 'item/{UserID:minlength(4)}/{ObjectType:minlength(4)}/{ObjectID:minlength(4)}/delete',
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);
        const UserID = request.params.UserID      
        var chk = new CheckUsers()
        var userdetails = chk.GetUserDetails(request)
        if (!(userdetails.userId == UserID))
        {
            return {
                status: 401,
                body: 'Not Authorized',
            };
        }
        else
        {
            var object = {}
            
            if (request.method === 'DELETE')
            {
                var objfromDb = context.extraInputs.get(cosmosInputItem);
                var objectfound = false
                for (const obj of objfromDb) {
                    object = obj
                    object.ttl = 1
                    objectfound = true
                }
                if (objectfound)
                {
                    context.extraOutputs.set(sendToCosmosDb, object);
                }                 
                data = data + `<div hx-get="/api/item/`+UserID+`/`+ObjectType+`/list" hx-target="#mainarea" hx-trigger="load delay:125ms"></div>`
            }    
        }
    
                       
        return { 
          body:  ``     
         };
    }
  });
*/

/*
  switch (ObjectID)
  {            
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
                                  body:  `<tbody hx-swap-oob="beforeend:table tbody">
                                              <tr><td>`+dataobject.id+`</td><td>`+dataobject.name+`</td><td>`+dataobject.data.type+`</td></tr> 
                                          </tbody>`

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
                              <tr><td>`+object.id+`</td><td>`+object.name+`</td><td>`+object.data.type+`</td><td><i class="fa-solid fa-pen"></i> <i class="fa-solid fa-trash"></i>  </td></tr>
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
*/