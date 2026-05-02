// jQuery Plugin Boilerplate
// A boilerplate for jumpstarting jQuery plugins development
// version 1.1, May 14th, 2011
// by Stefan Gabos

// remember to change every instance of "minidraw" to the name of your plugin!
(function($) {

    // here we go!
    $.minidraw = function(element, options) {

        // plugin's default options
        // this is private property and is  accessible only from inside the plugin
        var defaults = {

            width: '450',
            height: '300',
            width_brush: '3',
            

            // if your plugin is event-driven, you may provide callback capabilities for its events.
            // execute these functions before or after events of your plugin, so that users may customize
            // those particular events without changing the plugin's code
            onFoo: function() {}

        }

        // to avoid confusions, use "plugin" to reference the current instance of the object
        var plugin = this;

        // this will hold the merged default, and user-provided options
        // plugin's properties will be available through this object like:
        // plugin.settings.propertyName from inside the plugin or
        // element.data('minidraw').settings.propertyName from outside the plugin, where "element" is the
        // element the plugin is attached to;
        plugin.settings = {}




        var $element = $(element),  // reference to the jQuery version of DOM element the plugin is attached to
             element = element;        // reference to the actual DOM element

        var color = "#c30b0b"; // Couleur du pinceau
        //var width_brush = 5; // Largeur du pinceau
        var painting = false; // Suis-je en train de dessiner ?
        var started = false; // Ai-je commencé à dessiner ?
        var canvas, context, cursorX, cursorY; // Variables concernant le canvas définies plus tard
        var image1;
        var id = Math.round(new Date().getTime() + (Math.random() * 10000)) + '_' + Math.round(new Date().getTime() + (Math.random() * 10000));
        var erasing = false;
        var nbOperation = 0;
        var tabOperations = Array();
        var indiceCurrentHistory = 0;

        // the "constructor" method that gets called when the object is created
        plugin.init = function() {

            // the plugin's final properties are the merged default and user-provided options (if any)
            plugin.settings = $.extend({}, defaults, options);


            //$element.css('width',parseInt(defaults.width)+2);
            //$element.css('height',parseInt(defaults.height)+2);
            //$element.css('border','1px solid #ccc');
            //$element.css('display','inline-block');
            $element.addClass('minidraw');

            var html = "<div class='minidraw_toolbar' id='minidraw_toolbar_"+id+"'>";
            html += "<ul id='minidraw_toolbar0_"+id+"'>";
            html += "<li class='new'><i class='fa fa-file'></i></li></li>";
            html += "<li class='erase'><i class='fa fa-eraser'></i></li></li>";
            html += "<li class='disabled undo'><i class='fa fa-undo'></i></li></li>";
            html += "<li class='disabled repeat'><i class='fa fa-repeat'></i></li></li>";
            html += "</ul>";
            html += "<ul id='minidraw_toolbar1_"+id+"'>";
            html += "<li class='first color' val='#000000'><i class='fa fa-square' style='color:#000000'></i></li>";
            html += "<li class='color selected default' val='#c30b0b'><i class='fa fa-square' style='color:#c30b0b'></i></li>";
            html += "<li class='color' val='#0010a7'><i class='fa fa-square' style='color:#0010a7'></i></li>";
            html += "<li class='color' val='#029e3d'><i class='fa fa-square' style='color:#029e3d'></i></li>";
            html += "<li class='color' val='#ed8806'><i class='fa fa-square' style='color:#ed8806'></i></li>";
            html += "<li class='color' val='#8b3391'><i class='fa fa-square' style='color:#8b3391'></i></li>";
            html += "<li class='color' val='#edf00b'><i class='fa fa-square' style='color:#edf00b'></i></li>";
            html += "</ul>";


            html += "<ul id='minidraw_toolbar2_"+id+"'>";
            html += "<li class='first brushwidth brushwidth1' val='1'><i class='fa fa-circle'></i></li></li>";
            html += "<li class='brushwidth brushwidth3 selected' val='3'><i class='fa fa-circle'></i></li></li>";
            html += "<li class='brushwidth brushwidth5' val='5'><i class='fa fa-circle'></i></li></li>";
            html += "<li class='brushwidth brushwidth10' val='10'><i class='fa fa-circle'></i></li></li>";
            html += "</ul>";


            html += "</div>";

            $element.html(html+'<canvas class="minidraw" id="canvas_'+id+'" width="' + plugin.settings.width + '" height="' + plugin.settings.height + '"></canvas>');
            canvas = $("#canvas_"+id);
            //$(document).bind('selectstart',function(){ return false; });
            //document.onselectstart = function() {return false;}
            context = canvas[0].getContext('2d');

            $('#minidraw_toolbar1_'+id+' li').bind('click',function(){
                erasing = false;
                $('#minidraw_toolbar1_'+id+' li').removeClass('selected');
                $(this).addClass('selected');
            })


            $('#minidraw_toolbar1_'+id+' li.color').bind('click',function(){
                plugin.setColor($(this).attr('val'));
            })

            $('#minidraw_toolbar0_'+id+' li.new').bind('click',function(){
                plugin.clear();
                $('#minidraw_toolbar1_'+id+' li').removeClass('selected');
                $('#minidraw_toolbar1_'+id+' li.default').addClass('selected');
                plugin.setColor('#c30b0b');
                erasing = false;
            })

            $('#minidraw_toolbar0_'+id+' li.erase').bind('click',function(){
               erasing = true;
            })


            $('#minidraw_toolbar0_'+id+' li.undo').bind('click',function(){
               if ($(this).hasClass('disabled')) return;
               if (nbOperation<1) return;
               if (nbOperation==1) $(this).addClass('disabled');
               nbOperation--;
               plugin.setImageData(tabOperations[nbOperation-1]);
               
               
               $('#minidraw_toolbar0_'+id+' li.repeat').removeClass('disabled');
            })

            $('#minidraw_toolbar0_'+id+' li.repeat').bind('click',function(){
               if ($(this).hasClass('disabled')) return;
               if (nbOperation > tabOperations.length) return;
               plugin.setImageData(tabOperations[nbOperation]);
               nbOperation++;
               if (nbOperation >= tabOperations.length)
                    $(this).addClass('disabled');
            })


             $('#minidraw_toolbar2_'+id+' li').bind('click',function(){
                $('#minidraw_toolbar2_'+id+' li').removeClass('selected');
                $(this).addClass('selected');
                plugin.setBrushWidth($(this).attr('val'));
            })


            

            context.lineJoin = 'round';
            context.lineCap = 'round';

            canvas.mousedown(function(e) {
                moveStart(e, false);
            });
            
            // Relachement du Click sur tout le document, j'arrête de dessiner :
            canvas.mouseup(function() {
                moveEnd();
            });
            
            // Mouvement de la souris sur le canvas :
            canvas.mousemove(function(e) {
                move(e, false, this);
            });

            canvas.bind('touchstart', function(e) {
                moveStart(e, true);
            });
            
            // Relachement du doigt sur tout le document, j'arrête de dessiner :
            canvas.bind('touchend', function() {
                moveEnd();
            });
            
            // Mouvement du doigt sur le canvas :
            canvas.bind('touchmove', function(e) {
                move(e, true, this);
            });


            // code goes here

        }

        // public methods
        // these methods can be called like:
        // plugin.methodName(arg1, arg2, ... argn) from inside the plugin or
        // element.data('minidraw').publicMethod(arg1, arg2, ... argn) from outside the plugin, where "element"
        // is the element the plugin is attached to;

        // a public method. for demonstration purposes only - remove it!
        plugin.clear = function() {
            context.clearRect(0,0, canvas.width(), canvas.height());
           tabOperations[nbOperation] = plugin.getString();
            nbOperation++;
            tabOperations.splice(nbOperation);
            $('#minidraw_toolbar0_'+id+' li.undo').removeClass('disabled');
            $('#minidraw_toolbar0_'+id+' li.repeat').addClass('disabled');
        }

        plugin.setColor = function(col) {
            color = col;
        }

        plugin.setBackground = function(url) {
             $element.css('background','url('+url+') center center no-repeat');
        }

        plugin.setBrushWidth = function(width) {
             plugin.settings.width_brush = width;
        }

        plugin.getString = function() {
             return canvas[0].toDataURL("image/png");
        }

        plugin.setImageData = function(data) {
            context.clearRect(0,0, canvas.width(), canvas.height());
            image1 = new Image();
            image1.src = data;
            image1.addEventListener('load', function() {
                  context.drawImage(image1, 0, 0);
            });
            
        }

        plugin.setImage = function(url) {
            image1 = new Image();
            image1.src = url;
            image1.addEventListener('load', function() {
                  context.drawImage(image1, 0, 0);
                  tabOperations[nbOperation] = plugin.getString();
                  nbOperation++;
                  tabOperations.splice(nbOperation);
            });
        }




        // private methods
        // these methods can be called only from inside the plugin like:
        // methodName(arg1, arg2, ... argn)

        // a private method. for demonstration purposes only - remove it!
        var foo_private_method = function() {

            // code goes here
        }

        



        var drawLine = function() {
            // Si c'est le début, j'initialise
            if (!started) {
                // Je place mon curseur pour la première fois :
                context.beginPath();
                context.moveTo(cursorX, cursorY)
        ;       started = true;
            } 
            // Sinon je dessine
            else {
                if (!erasing) {
                    context.lineTo(cursorX, cursorY);
                    context.strokeStyle = color;
                    context.lineWidth = plugin.settings.width_brush;
                    context.stroke();
                }
                else {
                    context.clearRect (cursorX-10, cursorY-10,20,20);
                    //context.strokeStyle = color;
                    //context.lineWidth = width_brush;
                    //context.stroke();

                }
            }
        }

        var move = function(e, mobile, obj) {
            // Si je suis en train de dessiner (click souris enfoncé) :
            if (painting) {
                if (mobile) {
                    // Event mobile :
                    var ev = e.originalEvent;
                    e.preventDefault();
                    
                    // Set Coordonnées du doigt :
                    // cursorX = (ev.pageX - obj.offsetLeft); // 10 = décalage du curseur
                    // cursorY = (ev.pageY - obj.offsetTop);
                    cursorX = (ev.targetTouches[0].pageX - obj.offsetLeft); // 10 = décalage du curseur
                    var t = $(obj).offset();
                    cursorY = (ev.targetTouches[0].pageY - t.top);
                }
                else {
                    // Set Coordonnées de la souris :
                    var t = $(obj).offset();
                    cursorX = (e.pageX - obj.offsetLeft); // 10 = décalage du curseur
                    cursorY = (e.pageY - t.top);
                }
                
                // Dessine une ligne :
                drawLine();
            }
        }

        // Fonction fin de mouvement :
        var moveEnd = function() {
            painting = false;
            started = false;
            
            tabOperations[nbOperation] = plugin.getString();
            nbOperation++;
            $('#minidraw_toolbar0_'+id+' li.undo').removeClass('disabled');
            $('#minidraw_toolbar0_'+id+' li.repeat').addClass('disabled');
            tabOperations.splice(nbOperation);
            
            
        }

        //  Fonction début de mouvement :
        var moveStart = function(e, mobile) {
            painting = true;
            e.preventDefault();
            // Coordonnées de la souris :
            if (mobile) {
                // Event mobile :
                var ev = e.originalEvent;
                e.preventDefault();
                
                // Set Coordonnées du doigt :
                cursorX = (ev.pageX - this.offsetLeft); // 10 = décalage du curseur
                cursorY = (ev.pageY - this.offsetTop);
            }
            else {
                // Set Coordonnées de la souris :
                cursorX = (e.pageX - this.offsetLeft);
                cursorY = (e.pageY - this.offsetTop);
            }
        }

















        // fire up the plugin!
        // call the "constructor" method
        plugin.init();

    }

    // add the plugin to the jQuery.fn object
    $.fn.minidraw = function(options) {

        // iterate through the DOM elements we are attaching the plugin to
        return this.each(function() {

            // if plugin has not already been attached to the element
            if (undefined == $(this).data('minidraw')) {

                // create a new instance of the plugin
                // pass the DOM element and the user-provided options as arguments
                var plugin = new $.minidraw(this, options);

                // in the jQuery version of the element
                // store a reference to the plugin object
                // you can later access the plugin and its methods and properties like
                // element.data('minidraw').publicMethod(arg1, arg2, ... argn) or
                // element.data('minidraw').settings.propertyName
                $(this).data('minidraw', plugin);

            }

        });

    }

})(jQuery);