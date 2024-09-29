import pkgfn from '@azure/functions';
import CheckUsers from "./auth/CheckUsers.mjs";


const { app, HttpResponse, input} = pkgfn;

app.http('loginbutton', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'main/loginbutton',
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);

        var chk = new CheckUsers()
        var userdetails = chk.GetUserDetails(request)


        var htmldatastart = ``
        var buttondata = `<a href="/login"><i class="fa-solid fa-user"></i></a>`
        var htmldataend = ``
        if (userdetails.authorized)
        {
            buttondata = `<a href="/logout"><img src="https://avatars.githubusercontent.com/` + userdetails.userDetails + `?size=40" alt="logout" class="circular-square"></a>`
        }
     
        return { 
          body: htmldatastart + buttondata + htmldataend     
         };
    }
});